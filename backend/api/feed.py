"""Activity feed and reactions (docs/ENGAGEMENT_DESIGN.md §7 P12). Every route answers 404 while the admin switch is off."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services import feed as feed_service
from services.social_feature import require_social

router = APIRouter(dependencies=[Depends(require_social)])


def _reaction_state(db: Session, event_id: int, viewer_id: int) -> dict:
    return feed_service.reaction_summary(db, [event_id], viewer_id)[event_id]


@router.get("")
def get_feed(
    before: int | None = Query(default=None, ge=1, description="Event id to continue after (next_before of the last page)"),
    limit: int = Query(default=feed_service.DEFAULT_PAGE_SIZE, ge=1, le=feed_service.MAX_PAGE_SIZE),
    price_field: str = Query(default="price_trend", description="Price field for shared amounts"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return feed_service.feed_page(db, current_user.id, before=before, limit=limit, price_field=price_field)


def _checked_kind(kind: str) -> str:
    if kind not in feed_service.REACTION_KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown reaction. Use one of: {', '.join(feed_service.REACTION_KINDS)}")
    return kind


@router.put("/{event_id}/reactions/{kind}")
def add_reaction(
    event_id: int,
    kind: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _checked_kind(kind)
    if feed_service.visible_event(db, current_user.id, event_id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    feed_service.add_reaction(db, event_id, current_user.id, kind)
    db.commit()
    return _reaction_state(db, event_id, current_user.id)


@router.delete("/{event_id}/reactions/{kind}")
def remove_reaction(
    event_id: int,
    kind: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _checked_kind(kind)
    if feed_service.visible_event(db, current_user.id, event_id) is None:
        raise HTTPException(status_code=404, detail="Not found")
    feed_service.remove_reaction(db, event_id, current_user.id, kind)
    db.commit()
    return _reaction_state(db, event_id, current_user.id)


class CommentBody(BaseModel):
    text: str


def _commentable_event(db: Session, viewer_id: int, event_id: int):
    event = feed_service.visible_event(db, viewer_id, event_id, include_own=True)
    if event is None:
        raise HTTPException(status_code=404, detail="Not found")
    return event


@router.get("/{event_id}/comments")
def get_comments(
    event_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    event = _commentable_event(db, current_user.id, event_id)
    return {"items": feed_service.list_comments(db, event, current_user.id)}


@router.post("/{event_id}/comments", status_code=201)
def post_comment(
    event_id: int,
    body: CommentBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    event = _commentable_event(db, current_user.id, event_id)
    try:
        comment = feed_service.add_comment(db, event, current_user.id, body.text)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    db.commit()
    db.refresh(comment)
    return {
        "comment": feed_service.serialize_comment(comment, current_user, current_user.id, event.user_id),
        "comment_count": feed_service.comment_counts(db, [event.id])[event.id],
    }


@router.delete("/{event_id}/comments/{comment_id}")
def delete_comment(
    event_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    event = _commentable_event(db, current_user.id, event_id)
    outcome = feed_service.delete_comment(db, event, comment_id, current_user.id)
    if outcome == "missing":
        raise HTTPException(status_code=404, detail="Not found")
    if outcome == "forbidden":
        raise HTTPException(status_code=403, detail="Only the author or the event's owner can delete a comment")
    db.commit()
    return {"comment_count": feed_service.comment_counts(db, [event.id])[event.id]}
