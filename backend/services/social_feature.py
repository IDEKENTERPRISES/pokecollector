from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Setting


SOCIAL_SETTING_KEY = "social_features_enabled"


def social_enabled(db) -> bool:
    """Swap offers, the activity feed and the weekly challenge (docs/ENGAGEMENT_DESIGN.md §7, milestone D).

    On only when an admin switched them on and the server runs in multi-user mode. Missing means off."""
    row = db.query(Setting.value).filter(Setting.key == SOCIAL_SETTING_KEY).first()
    if not (row and str(row[0]).lower() == "true"):
        return False
    from api.auth import multi_user_enabled

    return multi_user_enabled(db)


def require_social(db: Session = Depends(get_db)) -> None:
    """Route dependency: social routes answer 404 while the switch is off, as if they did not exist."""
    if not social_enabled(db):
        raise HTTPException(status_code=404, detail="Not found")
