"""Chase goals (P10): CRUD, live progress and the wishlist / Planned Binder actions."""
import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, User, UserGoal
from services import goals as goal_service
from services.card_list_names import normalize_card_list_name

router = APIRouter()


class GoalCreate(BaseModel):
    kind: Literal["set", "set_master", "generation", "family", "artist", "custom"]
    params: dict = Field(default_factory=dict)
    pinned: bool = False


class GoalUpdate(BaseModel):
    pinned: Optional[bool] = None
    name: Optional[str] = Field(default=None, max_length=goal_service.NAME_MAX)


class BinderFromGoal(BaseModel):
    name: Optional[str] = Field(default=None, max_length=255)


def _own_goal(db: Session, user: User, goal_id: int) -> UserGoal:
    goal = db.query(UserGoal).filter(UserGoal.id == goal_id, UserGoal.user_id == user.id).first()
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    return goal


@router.get("")
def list_goals(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every goal with its live progress (pinned first)."""
    goals = db.query(UserGoal).filter(UserGoal.user_id == current_user.id).order_by(
        UserGoal.pinned.desc(), UserGoal.id
    ).all()
    ctx = goal_service.GoalContext(db, current_user.id)
    return {"goals": [goal_service.serialize(db, goal, goal_service.progress_for(ctx, goal)) for goal in goals]}


@router.get("/options")
def goal_options(
    artist: Optional[str] = Query(None, max_length=80),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """What the pickers offer: generations, evolution families and (searched) illustrators."""
    result = {
        "generations": [
            {"generation": gen, "region": info["region"], "species": len(info["dex_ids"])}
            for gen, info in sorted(goal_service.generations().items())
        ],
        "families": [
            {"id": entry["id"], "name": entry["name"], "dex_ids": entry["dex_ids"]}
            for entry in goal_service.families()
        ],
    }
    query = " ".join((artist or "").split())
    if len(query) >= 2:
        like = "%" + query.lower().replace("%", "").replace("_", "") + "%"
        rows = db.query(Card.artist, func.count(Card.id)).filter(
            Card.artist.isnot(None), Card.is_custom == False, func.lower(Card.artist).like(like)  # noqa: E712
        ).group_by(Card.artist).order_by(func.count(Card.id).desc(), Card.artist).limit(20).all()
        result["artists"] = [{"artist": name, "cards": count} for name, count in rows]
    return result


@router.post("", status_code=201)
def create_goal(body: GoalCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if db.query(func.count(UserGoal.id)).filter(UserGoal.user_id == current_user.id).scalar() >= goal_service.MAX_GOALS:
        raise HTTPException(status_code=400, detail="Too many goals")
    try:
        params = goal_service.clean_params(db, body.kind, body.params)
    except goal_service.GoalError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    duplicate = [
        goal for goal in db.query(UserGoal).filter(UserGoal.user_id == current_user.id, UserGoal.kind == body.kind)
        if goal.params == params
    ]
    if duplicate:
        raise HTTPException(status_code=409, detail="You already have that goal")
    now = datetime.datetime.utcnow()
    goal = UserGoal(
        user_id=current_user.id, kind=body.kind, params=params, pinned=body.pinned,
        created_at=now, updated_at=now,
    )
    db.add(goal)
    db.flush()
    ctx = goal_service.GoalContext(db, current_user.id)
    progress = goal_service.progress_for(ctx, goal)
    # The current thresholds are recorded now, so the evaluator never pushes for what already exists.
    goal.milestones = goal_service.thresholds_reached(progress["percent"])
    if 100 in goal.milestones:
        goal.completed_at = now
    db.commit()
    db.refresh(goal)
    return goal_service.serialize(db, goal, progress)


@router.get("/{goal_id}")
def get_goal(goal_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    goal = _own_goal(db, current_user, goal_id)
    ctx = goal_service.GoalContext(db, current_user.id)
    return goal_service.serialize(db, goal, goal_service.progress_for(ctx, goal, detail=True))


@router.patch("/{goal_id}")
def update_goal(
    goal_id: int, body: GoalUpdate,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    goal = _own_goal(db, current_user, goal_id)
    if body.pinned is not None:
        goal.pinned = body.pinned
    if body.name is not None and goal.kind == "custom":
        name = " ".join(body.name.split())
        if not name:
            raise HTTPException(status_code=422, detail="A goal needs a name")
        goal.params = {**(goal.params or {}), "name": name}
    goal.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(goal)
    return goal_service.serialize(db, goal)


@router.delete("/{goal_id}")
def delete_goal(goal_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    goal = _own_goal(db, current_user, goal_id)
    db.delete(goal)
    db.commit()
    return {"deleted": True}


@router.get("/{goal_id}/wishlist")
def wishlist_preview(goal_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """How many missing cards "Add to wishlist" would add (the UI asks before it does)."""
    goal = _own_goal(db, current_user, goal_id)
    ctx = goal_service.GoalContext(db, current_user.id)
    return {"to_add": len(goal_service.wishlist_plan(ctx, goal))}


@router.post("/{goal_id}/wishlist")
def add_missing_to_wishlist(goal_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    goal = _own_goal(db, current_user, goal_id)
    ctx = goal_service.GoalContext(db, current_user.id)
    result = goal_service.add_to_wishlist(ctx, goal)
    db.commit()
    return result


@router.post("/{goal_id}/binder", status_code=201)
def make_planned_binder(
    goal_id: int, body: BinderFromGoal,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """A Planned Binder (a wishlist-type binder) holding the goal's cards as they are today."""
    goal = _own_goal(db, current_user, goal_id)
    ctx = goal_service.GoalContext(db, current_user.id)
    cards = goal_service.all_cards(ctx, goal)
    if not cards:
        raise HTTPException(status_code=422, detail="This goal has no cards yet")
    now = datetime.datetime.utcnow()
    binder = Binder(
        name=normalize_card_list_name(body.name or goal_service.goal_title(db, goal)),
        binder_type="wishlist", user_id=current_user.id, created_at=now, updated_at=now,
    )
    db.add(binder)
    db.flush()
    db.add_all([
        BinderCard(binder_id=binder.id, card_id=row.id, required_quantity=1, added_at=now) for row, _ in cards
    ])
    db.commit()
    return {"binder_id": binder.id, "name": binder.name, "cards": len(cards)}
