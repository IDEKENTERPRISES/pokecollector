"""The weekly challenge (docs/SOCIAL_DESIGN.md §7). Answers 404 while the admin switch is off."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services import challenge as challenge_service
from services.social_feature import require_social

router = APIRouter(dependencies=[Depends(require_social)])


@router.get("")
def get_challenge(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return challenge_service.challenge_view(db, current_user.id)
