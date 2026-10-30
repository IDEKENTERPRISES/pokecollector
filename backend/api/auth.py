import logging
import os
from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import get_db, get_setting, save_setting
from models import User, UserSession
from services.auth import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    DUMMY_PASSWORD_HASH,
    create_access_token,
    decode_token,
    hash_password,
    verify_password,
)
from services.sessions import (
    create_session,
    get_active_session,
    revoke_session,
    revoke_sessions,
    touch,
)
from services.client_ip import client_ip
from services.login_throttle import login_throttle

router = APIRouter()
logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "trainer"
    avatar_id: int | None = None
    must_change_password: bool = False


class UpdateUserRequest(BaseModel):
    username: str | None = None
    password: str | None = None
    role: str | None = None
    is_active: bool | None = None
    avatar_id: int | None = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForceChangePasswordRequest(BaseModel):
    new_password: str


MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_BYTES = 72  # bcrypt cannot hash more than this
VALID_ROLES = ("admin", "trainer")
# While a temporary password is in force only these routes work, so the account
# cannot be used for anything but replacing it.
PASSWORD_CHANGE_ALLOWED_PATHS = {
    "/api/auth/me",
    "/api/auth/me/force-password",
    "/api/auth/logout",
    "/api/auth/mode",
}


def validate_new_password(password: str | None) -> None:
    if password is None:
        return
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters",
        )
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise HTTPException(status_code=400, detail="Password is too long (72 bytes at most)")


def validate_role(role: str | None) -> None:
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of: {', '.join(VALID_ROLES)}")


def validate_avatar_id(avatar_id: int | None):
    if avatar_id is not None and (avatar_id < 1 or avatar_id > 151):
        raise HTTPException(status_code=400, detail="avatar_id must be 1-151")


def field_was_set(model: BaseModel, field_name: str) -> bool:
    if hasattr(model, "model_fields_set"):
        return field_name in model.model_fields_set
    return field_name in model.__fields_set__


def active_admin_count(db: Session) -> int:
    return db.query(User).filter(User.role == "admin", User.is_active == True).count()


def ensure_keeps_active_admin(db: Session, user: User, data: UpdateUserRequest):
    next_role = data.role if data.role is not None else user.role
    next_is_active = data.is_active if data.is_active is not None else user.is_active
    removes_active_admin = user.role == "admin" and user.is_active and (
        next_role != "admin" or not next_is_active
    )
    if removes_active_admin and active_admin_count(db) <= 1:
        raise HTTPException(status_code=400, detail="At least one active admin account is required")


def _sync_public_handle_for_username(db: Session, user: User, username: str) -> None:
    from services import public_profile as pp

    if not user.is_profile_public:
        user.public_handle = None
        return
    try:
        pp.assign_public_handle(db, user, trainer_name=username)
    except pp.HandleConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except pp.HandleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def env_user_mode(*, warn_invalid: bool = False) -> str | None:
    """USER_MODE pins the mode from the environment, overriding the stored setting:
    'single' forces single-user (login screen off), 'multi' forces multi-user (login on).
    Unset, blank, or unrecognised means no override. It is the recovery hatch for an admin
    locked out of multi-user mode: set USER_MODE=single, restart, regain local access, reset
    the password, then remove it. Forcing single-user disables the login screen, so that
    direction is a local/LAN recovery tool, not something to leave set on a public install."""
    raw = os.getenv("USER_MODE", "").strip().lower().replace("-", "_")
    if raw in {"single", "single_user"}:
        return "single"
    if raw in {"multi", "multi_user"}:
        return "multi"
    if raw and warn_invalid:
        logger.warning("USER_MODE=%r is not 'single' or 'multi'; ignoring it.", os.getenv("USER_MODE"))
    return None


def mode_is_env_locked() -> bool:
    """True when USER_MODE pins the mode, so the in-app toggle cannot change it."""
    return env_user_mode() is not None


def multi_user_enabled(db: Session) -> bool:
    """True when the login screen is enforced. The USER_MODE env override wins; otherwise the
    stored setting, falling back to 'more than one user exists' when it has never been set."""
    override = env_user_mode()
    if override is not None:
        return override == "multi"
    multi = get_setting("multi_user_mode")
    if multi is None:
        multi = "true" if db.query(User).count() > 1 else "false"
    return str(multi).lower() == "true"


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
    request: Request = None,
) -> User:
    if not token:
        if not multi_user_enabled(db):
            admin = db.query(User).filter(User.role == "admin", User.is_active == True).first()
            if admin:
                return admin
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    session = get_active_session(db, payload.get("sid"), user.id)
    if session is None:
        # Ended (signed out, password changed...), expired, or issued before sessions
        # existed. Either way the client must sign in again.
        raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
    touch(db, session)
    if (
        user.must_change_password
        and request is not None
        and request.url.path.rstrip("/") not in PASSWORD_CHANGE_ALLOWED_PATHS
    ):
        raise HTTPException(status_code=403, detail="You must change your temporary password first.")
    return user


def get_optional_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """Returns user if authenticated, None otherwise. For backward compat during transition."""
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if user_id is None:
            return None
    except JWTError:
        return None
    user = db.query(User).filter(User.id == int(user_id), User.is_active == True).first()
    if user is None or get_active_session(db, payload.get("sid"), user.id) is None:
        return None
    return user


def session_id_from_token(token: str | None) -> str | None:
    """The session id inside an already-validated token (None if unreadable)."""
    if not token:
        return None
    try:
        return decode_token(token).get("sid")
    except JWTError:
        return None


@router.post("/login", response_model=TokenResponse)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    ip = client_ip(request)
    retry_after = login_throttle.retry_after(ip, form_data.username)
    if retry_after:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts. Try again in {max(1, round(retry_after / 60))} minute(s).",
            headers={"Retry-After": str(retry_after)},
        )
    user = db.query(User).filter(User.username == form_data.username, User.is_active == True).first()
    # An unknown user still pays for a password check, so timing does not reveal
    # which usernames exist.
    password_ok = verify_password(form_data.password, user.hashed_password if user else DUMMY_PASSWORD_HASH)
    if not user or not password_ok:
        login_throttle.record_failure(ip, form_data.username)
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    login_throttle.record_success(form_data.username)
    lifetime = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    session = create_session(db, user.id, lifetime, request.headers.get("user-agent"))
    token = create_access_token(
        {"sub": str(user.id), "role": user.role, "sid": session.id},
        expires_delta=lifetime,
    )
    return TokenResponse(
        access_token=token,
        user={
            "id": user.id,
            "username": user.username,
            "role": user.role,
            "avatar_id": user.avatar_id,
            "must_change_password": user.must_change_password,
        },
    )


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "role": current_user.role,
        "avatar_id": current_user.avatar_id,
        "must_change_password": current_user.must_change_password,
    }


@router.get("/mode")
def get_auth_mode(db: Session = Depends(get_db)):
    # `locked` tells the UI to disable the toggle: the mode is pinned by USER_MODE.
    return {"multi_user": multi_user_enabled(db), "locked": mode_is_env_locked()}


@router.put("/mode")
def set_auth_mode(
    enabled: bool = Body(..., embed=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if mode_is_env_locked():
        raise HTTPException(
            status_code=409,
            detail="User mode is pinned by the USER_MODE environment variable and cannot be changed here",
        )
    save_setting("multi_user_mode", str(enabled).lower())
    return {"multi_user": enabled}


@router.get("/users")
def list_users(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    users = db.query(User).order_by(User.id.asc()).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "is_active": u.is_active,
            "avatar_id": u.avatar_id,
            "created_at": str(u.created_at),
        }
        for u in users
    ]


@router.post("/users")
def create_user(
    data: CreateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    validate_avatar_id(data.avatar_id)
    validate_role(data.role)
    validate_new_password(data.password)
    existing = db.query(User).filter(User.username == data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(
        username=data.username,
        hashed_password=hash_password(data.password),
        role=data.role,
        is_active=True,
        avatar_id=data.avatar_id,
        must_change_password=data.must_change_password,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    data: UpdateUserRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if field_was_set(data, "avatar_id"):
        validate_avatar_id(data.avatar_id)
    validate_role(data.role)
    validate_new_password(data.password)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    ensure_keeps_active_admin(db, user, data)
    if data.username is not None:
        _sync_public_handle_for_username(db, user, data.username)
        user.username = data.username
    if data.password is not None:
        user.hashed_password = hash_password(data.password)
        # A reset must end whoever held the old password.
        revoke_sessions(db, user.id, commit=False)
    if data.role is not None:
        user.role = data.role
    if data.is_active is not None:
        user.is_active = data.is_active
        if not data.is_active:
            # Otherwise old tokens would work again if the account is re-enabled.
            revoke_sessions(db, user.id, commit=False)
    if field_was_set(data, "avatar_id"):
        user.avatar_id = data.avatar_id
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Trainer name or public URL is already taken") from None
    return {"id": user.id, "username": user.username, "role": user.role, "is_active": user.is_active, "avatar_id": user.avatar_id}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Delete all user-owned data first (foreign key constraints)
    from models import (
        Binder,
        BinderCard,
        BinderSlot,
        Card,
        CollectionCardPhoto,
        CollectionItem,
        CustomCardMatch,
        EventReaction,
        ImageCache,
        NotificationQueue,
        PortfolioSnapshot,
        PriceHistory,
        ProgressState,
        ProductCard,
        ProductLedgerEntry,
        ProductPurchase,
        SwapOffer,
        SwapOfferItem,
        Trade,
        TradeItem,
        UserAchievement,
        UserDailyActivity,
        UserEvent,
        UserGoal,
        UserSetting,
        UserXpLedger,
        WishlistItem,
    )
    owned_custom_card_ids = [
        card_id for (card_id,) in db.query(Card.id).filter(
            Card.is_custom == True,
            Card.custom_owner_id == user_id,
        ).all()
    ]
    user_binder_ids = db.query(Binder.id).filter(Binder.user_id == user_id)
    db.query(BinderSlot).filter(
        BinderSlot.binder_id.in_(user_binder_ids)
    ).delete(synchronize_session=False)
    db.query(BinderCard).filter(
        BinderCard.binder_id.in_(user_binder_ids)
    ).delete(synchronize_session=False)
    db.query(Binder).filter(Binder.user_id == user_id).delete()
    db.query(ProductLedgerEntry).filter(ProductLedgerEntry.user_id == user_id).delete()
    db.query(ProductCard).filter(ProductCard.user_id == user_id).delete()
    db.query(CollectionCardPhoto).filter(CollectionCardPhoto.user_id == user_id).delete()
    db.query(CollectionItem).filter(CollectionItem.user_id == user_id).delete()
    db.query(WishlistItem).filter(WishlistItem.user_id == user_id).delete()
    db.query(ProductPurchase).filter(ProductPurchase.user_id == user_id).delete()
    db.query(TradeItem).filter(TradeItem.user_id == user_id).delete(
        synchronize_session=False
    )
    db.query(Trade).filter(Trade.user_id == user_id).delete(
        synchronize_session=False
    )
    # Swap offers this trainer is part of go; the other trainer's logged trade stays, unlinked.
    user_offer_ids = db.query(SwapOffer.id).filter(
        (SwapOffer.from_user_id == user_id) | (SwapOffer.to_user_id == user_id)
    )
    db.query(Trade).filter(Trade.swap_offer_id.in_(user_offer_ids)).update(
        {"swap_offer_id": None}, synchronize_session=False
    )
    db.query(SwapOfferItem).filter(SwapOfferItem.offer_id.in_(user_offer_ids)).delete(
        synchronize_session=False
    )
    db.query(SwapOffer).filter(
        (SwapOffer.from_user_id == user_id) | (SwapOffer.to_user_id == user_id)
    ).delete(synchronize_session=False)
    db.query(PortfolioSnapshot).filter(PortfolioSnapshot.user_id == user_id).delete()
    db.query(UserSetting).filter(UserSetting.user_id == user_id).delete()
    # Reactions first: the ones this trainer gave, and everyone's reactions to this trainer's events.
    own_event_ids = db.query(UserEvent.id).filter(UserEvent.user_id == user_id)
    db.query(EventReaction).filter(
        (EventReaction.user_id == user_id) | EventReaction.event_id.in_(own_event_ids)
    ).delete(synchronize_session=False)
    for progress_model in (
        UserAchievement, UserDailyActivity, UserEvent, UserGoal, UserXpLedger, ProgressState, NotificationQueue,
    ):
        db.query(progress_model).filter(progress_model.user_id == user_id).delete(
            synchronize_session=False
        )
    db.query(UserSession).filter(UserSession.user_id == user_id).delete(synchronize_session=False)
    if owned_custom_card_ids:
        db.query(CustomCardMatch).filter(
            CustomCardMatch.custom_card_id.in_(owned_custom_card_ids)
        ).delete(synchronize_session=False)
        db.query(PriceHistory).filter(
            PriceHistory.card_id.in_(owned_custom_card_ids)
        ).delete(synchronize_session=False)
        db.query(TradeItem).filter(
            TradeItem.card_id.in_(owned_custom_card_ids)
        ).update({"card_id": None}, synchronize_session=False)
        for card_id in owned_custom_card_ids:
            db.query(ImageCache).filter(
                ImageCache.image_key.like(f"card:{card_id}:%")
            ).delete(synchronize_session=False)
        db.query(Card).filter(Card.id.in_(owned_custom_card_ids)).delete(
            synchronize_session=False
        )
    traces_revoked = False
    try:
        from services.scan_trace import revoke_user_traces

        revoke_user_traces(user_id)
        traces_revoked = True
    except OSError as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="User scanner diagnostics could not be deleted.",
        ) from exc
    db.delete(user)
    try:
        db.commit()
    except Exception:
        db.rollback()
        if traces_revoked:
            try:
                from services.scan_trace import clear_user_trace_revocation

                clear_user_trace_revocation(user_id)
            except OSError:
                logger.exception(
                    "Failed to clear scanner diagnostics revocation after user deletion rollback"
                )
        raise
    return {"message": "User deleted"}


@router.put("/me/password")
def change_password(
    data: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    token: str | None = Depends(oauth2_scheme),
):
    if not verify_password(data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    validate_new_password(data.new_password)
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    # Anyone holding the old password (or a stolen token) is signed out; this device stays.
    revoke_sessions(db, current_user.id, keep=session_id_from_token(token), commit=False)
    db.commit()
    return {"message": "Password changed"}


@router.put("/me/force-password")
def force_change_password(
    data: ForceChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    token: str | None = Depends(oauth2_scheme),
):
    if not current_user.must_change_password:
        raise HTTPException(status_code=400, detail="Password change is not required")
    validate_new_password(data.new_password)
    current_user.hashed_password = hash_password(data.new_password)
    current_user.must_change_password = False
    revoke_sessions(db, current_user.id, keep=session_id_from_token(token), commit=False)
    db.commit()
    return {"message": "Password changed"}


@router.post("/logout")
def logout(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    token: str | None = Depends(oauth2_scheme),
):
    """End this device's session. The token stops working immediately."""
    session_id = session_id_from_token(token)
    if session_id:
        revoke_session(db, current_user.id, session_id)
    return {"message": "Signed out"}


@router.post("/logout-others")
def logout_other_devices(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    token: str | None = Depends(oauth2_scheme),
):
    """Sign out every device except this one."""
    ended = revoke_sessions(db, current_user.id, keep=session_id_from_token(token))
    return {"ended": ended}


@router.get("/sessions")
def list_sessions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    token: str | None = Depends(oauth2_scheme),
):
    current_session_id = session_id_from_token(token)
    rows = (
        db.query(UserSession)
        .filter(UserSession.user_id == current_user.id)
        .order_by(UserSession.last_used_at.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "current": row.id == current_session_id,
            "user_agent": row.user_agent,
            "created_at": str(row.created_at),
            "last_used_at": str(row.last_used_at),
            "expires_at": str(row.expires_at),
        }
        for row in rows
    ]


@router.delete("/sessions/{session_id}")
def revoke_one_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not revoke_session(db, current_user.id, session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"message": "Session ended"}


@router.put("/me/avatar")
def change_avatar(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    avatar_id = data.get("avatar_id")
    validate_avatar_id(avatar_id)
    current_user.avatar_id = avatar_id
    db.commit()
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}


@router.put("/me/username")
def change_username(data: dict, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_username = (data.get("username") or "").strip()
    if not new_username or len(new_username) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters")
    if len(new_username) > 32:
        raise HTTPException(status_code=400, detail="Username must be at most 32 characters")
    existing = db.query(User).filter(User.username == new_username, User.id != current_user.id).first()
    if existing:
        raise HTTPException(status_code=409, detail="Username already taken")
    _sync_public_handle_for_username(db, current_user, new_username)
    current_user.username = new_username
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Trainer name or public URL is already taken") from None
    return {"id": current_user.id, "username": current_user.username, "role": current_user.role, "avatar_id": current_user.avatar_id}
