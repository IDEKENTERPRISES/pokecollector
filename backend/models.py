from sqlalchemy import (
    Column, String, Integer, Float, DateTime, Date, Boolean,
    CheckConstraint, ForeignKey, Text, JSON, UniqueConstraint, LargeBinary, Index, Table
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy.dialects.postgresql import JSONB
from database import Base

POKEDEX_JSON = JSON(none_as_null=True).with_variant(JSONB(none_as_null=True), "postgresql")
IDEMPOTENCY_JSON = JSON(none_as_null=True).with_variant(JSONB(none_as_null=True), "postgresql")
PORTFOLIO_CALCULATION_VERSION = 2
COLLECTION_VARIANT_CHECK = "variant IN ('Normal', 'Holo', 'Reverse Holo', 'First Edition')"


class Set(Base):
    __tablename__ = "sets"

    id = Column(String, primary_key=True)    # Composite DB key: "sv1_en" / "sv1_zh-tw"
    tcg_set_id = Column(String)              # Original TCGdex set ID: "sv1"
    name = Column(String, nullable=False)
    series = Column(String)
    release_date = Column(String)
    total = Column(Integer, default=0)
    printed_total = Column(Integer, default=0)
    images_symbol = Column(String)
    images_logo = Column(String)
    abbreviation = Column(String, nullable=True)
    series_id = Column(String, nullable=True)      # TCGdex series ID: "sv"
    series_logo = Column(String, nullable=True)    # Official series logo URL (with .webp)
    is_new = Column(Boolean, default=False)
    is_digital = Column(Boolean, default=False)
    lang = Column(String, default="en")      # TCGdex language code, NEVER "both"
    updated_at = Column(DateTime, default=func.now())

    # Relationship to cards via tcg_set_id and lang (no DB-level FK, joined in Python): the same
    # tcg_set_id exists once per language, so joining on it alone would mix the languages.
    # Use explicit primaryjoin so SQLAlchemy can resolve the join
    cards = relationship(
        "Card",
        primaryjoin="and_(Set.tcg_set_id == foreign(Card.set_id), Set.lang == foreign(Card.lang))",
        foreign_keys="[Card.set_id, Card.lang]",
        lazy="dynamic",
        viewonly=True,
        overlaps="set_ref",
    )


class Card(Base):
    __tablename__ = "cards"

    id = Column(String, primary_key=True)          # Composite DB key: "sv1-1_en" / "sv1-1_zh-tw"
    tcg_card_id = Column(String, nullable=True)    # Original TCGdex ID "sv1-1"; NULL for custom cards
    name = Column(String, nullable=False)
    set_id = Column(String, nullable=True)   # Original TCGdex set ID (no FK constraint)
    number = Column(String)
    rarity = Column(String)
    types = Column(JSON)
    supertype = Column(String)
    subtypes = Column(JSON)
    hp = Column(String)
    artist = Column(String)
    stage = Column(String)
    evolve_from = Column(String)
    suffix = Column(String)
    trainer_type = Column(String)
    energy_type = Column(String)
    card_effect = Column(String)
    regulation_mark = Column(String)
    attacks = Column(JSON)
    abilities = Column(JSON)
    weaknesses = Column(JSON)
    resistances = Column(JSON)
    dex_ids = Column(POKEDEX_JSON)
    pokedex_entry_ids = Column(POKEDEX_JSON)
    cardmarket_products = Column(POKEDEX_JSON)
    retreat = Column(Integer)
    playable_fingerprint = Column(String)
    images_small = Column(String)
    images_large = Column(String)
    image_source_lang = Column(String, nullable=True)  # Set when images are copied from another TCGdex language
    data_source_lang = Column(String, nullable=True)   # Set when metadata is copied from another TCGdex language
    custom_image_url = Column(String, nullable=True)   # Manual temporary fallback while TCGdex has no image
    is_custom = Column(Boolean, default=False)
    custom_owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    is_shared_template = Column(Boolean, default=False, nullable=False)
    custom_source_card_id = Column(String, nullable=True, index=True)
    is_digital = Column(Boolean, default=False)
    lang = Column(String, default="en")      # TCGdex language code
    # Cardmarket EUR prices
    price_market = Column(Float)
    price_low = Column(Float)
    price_mid = Column(Float)
    price_high = Column(Float)
    price_trend = Column(Float)
    price_avg1 = Column(Float)
    price_avg7 = Column(Float)
    price_avg30 = Column(Float)
    # Cardmarket EUR holo prices
    price_market_holo = Column(Float)
    price_low_holo = Column(Float)
    price_trend_holo = Column(Float)
    price_avg1_holo = Column(Float)
    price_avg7_holo = Column(Float)
    price_avg30_holo = Column(Float)
    # TCGPlayer USD prices — normal variant
    price_tcg_normal_low = Column(Float)
    price_tcg_normal_mid = Column(Float)
    price_tcg_normal_high = Column(Float)
    price_tcg_normal_market = Column(Float)
    # TCGPlayer USD prices — reverse holofoil variant
    price_tcg_reverse_low = Column(Float)
    price_tcg_reverse_mid = Column(Float)
    price_tcg_reverse_market = Column(Float)
    # TCGPlayer USD prices — holofoil variant
    price_tcg_holo_low = Column(Float)
    price_tcg_holo_mid = Column(Float)
    price_tcg_holo_market = Column(Float)
    price_source_lang = Column(String, nullable=True)  # Set when prices are copied from another TCGdex language
    last_price_sync_attempt_at = Column(DateTime, nullable=True)
    last_price_sync_success_at = Column(DateTime, nullable=True)
    last_metadata_enrichment_attempt_at = Column(DateTime, nullable=True, index=True)
    # Card variants from TCGdex
    variants_normal = Column(Boolean)
    variants_reverse = Column(Boolean)
    variants_holo = Column(Boolean)
    variants_first_edition = Column(Boolean)
    updated_at = Column(DateTime, default=func.now())

    # Relationship to Set via tcg_set_id (viewonly, no DB FK)
    set_ref = relationship(
        "Set",
        primaryjoin="and_(Set.tcg_set_id == foreign(Card.set_id), Set.lang == foreign(Card.lang))",
        foreign_keys="[Card.set_id, Card.lang]",
        uselist=False,
        viewonly=True,
        overlaps="cards",
    )
    collection_items = relationship("CollectionItem", back_populates="card", lazy="dynamic")
    wishlist_items = relationship("WishlistItem", back_populates="card", lazy="dynamic")
    price_history = relationship("PriceHistory", back_populates="card", lazy="dynamic")
    binder_cards = relationship("BinderCard", back_populates="card", lazy="dynamic")
    custom_owner = relationship("User", foreign_keys=[custom_owner_id])


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_public_handle", "public_handle", unique=True),
        CheckConstraint(
            "wishlist_visibility IN ('private', 'trade_matches', 'public')",
            name="ck_users_wishlist_visibility",
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="trainer")  # "admin" or "trainer"
    is_active = Column(Boolean, default=True)
    avatar_id = Column(Integer, nullable=True)  # Pokemon number (1-151) for avatar sprite
    public_handle = Column(String, nullable=True)
    is_profile_public = Column(Boolean, default=False, nullable=False)
    public_show_values = Column(Boolean, default=False, nullable=False)
    wishlist_visibility = Column(String, default="private", nullable=False)
    must_change_password = Column(Boolean, default=False)
    created_at = Column(DateTime, default=func.now())


class UserSession(Base):
    """One signed-in device. The login token carries this row's id as its `sid`
    claim and is only honoured while the row exists, so a session can be ended
    (sign out, password change, deactivation, "sign out other devices") without
    waiting for the token to expire."""
    __tablename__ = "user_sessions"

    id = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    last_used_at = Column(DateTime, default=func.now(), nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    user_agent = Column(String(255), nullable=True)


class Invite(Base):
    """An admin-issued invitation to create an account. Only the SHA-256 of the token is stored,
    so a database leak does not expose usable links. Single use; status is derived from the
    timestamps (pending, used, expired, revoked)."""
    __tablename__ = "invites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    token_hash = Column(String(64), unique=True, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    role = Column(String, default="trainer", nullable=False)
    note = Column(String(200), nullable=True)
    used_at = Column(DateTime, nullable=True)
    used_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    revoked_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class AuditLog(Base):
    """Append-only record of security-relevant actions. The actor is a plain id (no foreign key)
    so entries outlive a deleted account."""
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_created_at", "created_at"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    actor_user_id = Column(Integer, nullable=True)
    action = Column(String(64), nullable=False, index=True)
    target_type = Column(String(32), nullable=True)
    target_id = Column(String(64), nullable=True)
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)
    details = Column(Text, nullable=True)  # JSON text


collection_printing_detail_tags = Table(
    "collection_printing_detail_tags",
    Base.metadata,
    Column(
        "collection_item_id",
        Integer,
        ForeignKey("collection.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "printing_detail_tag_id",
        Integer,
        ForeignKey("printing_detail_tags.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Index("ix_collection_printing_detail_tag", "printing_detail_tag_id"),
)

product_card_printing_detail_tags = Table(
    "product_card_printing_detail_tags",
    Base.metadata,
    Column("product_card_id", Integer, ForeignKey("product_cards.id", ondelete="CASCADE"), primary_key=True),
    Column("printing_detail_tag_id", Integer, ForeignKey("printing_detail_tags.id", ondelete="CASCADE"), primary_key=True),
    Index("ix_product_card_printing_detail_tag", "printing_detail_tag_id"),
)

product_ledger_printing_detail_tags = Table(
    "product_ledger_printing_detail_tags",
    Base.metadata,
    Column("product_ledger_entry_id", Integer, ForeignKey("product_ledger_entries.id", ondelete="CASCADE"), primary_key=True),
    Column("printing_detail_tag_id", Integer, ForeignKey("printing_detail_tags.id", ondelete="CASCADE"), primary_key=True),
    Index("ix_product_ledger_printing_detail_tag", "printing_detail_tag_id"),
)

trade_item_printing_detail_tags = Table(
    "trade_item_printing_detail_tags",
    Base.metadata,
    Column("trade_item_id", Integer, ForeignKey("trade_items.id", ondelete="CASCADE"), primary_key=True),
    Column("printing_detail_tag_id", Integer, ForeignKey("printing_detail_tags.id", ondelete="CASCADE"), primary_key=True),
    Index("ix_trade_item_printing_detail_tag", "printing_detail_tag_id"),
)


class PrintingDetailTag(Base):
    """Reusable, user-scoped descriptive metadata for a physical card copy."""

    __tablename__ = "printing_detail_tags"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(80), nullable=False)
    # NFKD/case-fold normalization can expand an 80-character display name
    # (for example, ligatures), so it is not indexed directly. The fixed-size
    # digest is the user-scoped uniqueness key and avoids PostgreSQL index-size
    # failures for valid Unicode names.
    normalized_name = Column(String(1440), nullable=False)
    normalized_key = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=func.now(), nullable=False)

    collection_items = relationship(
        "CollectionItem",
        secondary=collection_printing_detail_tags,
        back_populates="printing_detail_tags",
    )
    product_cards = relationship("ProductCard", secondary=product_card_printing_detail_tags, back_populates="printing_detail_tags")
    product_ledger_entries = relationship("ProductLedgerEntry", secondary=product_ledger_printing_detail_tags, back_populates="printing_detail_tags")
    trade_items = relationship("TradeItem", secondary=trade_item_printing_detail_tags, back_populates="printing_detail_tags")

    __table_args__ = (
        UniqueConstraint("user_id", "normalized_key", name="uq_printing_detail_tag_user_key"),
        CheckConstraint("length(name) BETWEEN 1 AND 80", name="ck_printing_detail_tag_name_length"),
        CheckConstraint("length(normalized_name) BETWEEN 1 AND 1440", name="ck_printing_detail_tag_normalized_length"),
        CheckConstraint("length(normalized_key) = 64", name="ck_printing_detail_tag_key_length"),
    )


class CollectionItem(Base):
    __tablename__ = "collection"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    quantity = Column(Integer, default=1)
    condition = Column(String, default="NM")  # Mint/NM/LP/MP/HP
    variant = Column(String, nullable=False, default="Normal")  # Normal/Holo/Reverse Holo/First Edition
    purchase_price = Column(Float)
    lang = Column(String, default="en")  # fixed TCGdex card language
    added_at = Column(DateTime, default=func.now())
    # When the owner acquired this copy. NULL means "same as added_at", so rows
    # inherit the date they were added unless the owner overrides it. added_at
    # itself is never edited: Recently Added and sync-change detection rely on it.
    acquired_at = Column(DateTime, nullable=True)
    # Foil pattern id for the holo viewer; NULL means automatic.
    foil_pattern = Column(String, nullable=True)

    card = relationship("Card", back_populates="collection_items")
    printing_detail_tags = relationship(
        "PrintingDetailTag",
        secondary=collection_printing_detail_tags,
        back_populates="collection_items",
        lazy="selectin",
        order_by="PrintingDetailTag.name",
    )

    __table_args__ = (
        CheckConstraint(COLLECTION_VARIANT_CHECK, name="ck_collection_variant"),
    )

    @property
    def printing_details(self):
        return self.printing_detail_tags


class CollectionCardPhoto(Base):
    """One private photograph per owner and catalogue card.

    Roughly one card in fourteen — trainer kits, Japanese printings, the newest
    energy subsets — has no TCGdex image, and the collection shows a card back
    for it. The scanner already took a photograph of the physical card, so this
    keeps that photo instead of discarding it on resolve.

    Deliberately keyed by owner and card rather than stored on the shared card:

      * `cards` is a catalogue shared by every user of the instance, and
        `/api/images` is mounted without authentication (see api/images.py,
        which gates on set/language visibility rather than on a user). A photo
        stored there would be served to anyone who can reach the instance.
      * A photograph of a card is also a photograph of whatever it was resting
        on. That is the owner's, not the catalogue's.

    All grouped collection rows for the same card share this photo. That matches
    catalogue artwork: condition, variant, price and quantity do not create a
    different printing. The bytes remain in a separate authenticated table so
    ordinary collection queries only ever load a yes/no flag.
    """
    __tablename__ = "collection_card_photos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    card_id = Column(String, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False, index=True)
    data = Column(LargeBinary, nullable=False)
    content_type = Column(String, default="image/jpeg")
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "card_id", name="uq_collection_card_photo_user_card"),
    )


class WishlistItem(Base):
    __tablename__ = "wishlist"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    quantity = Column(Integer, default=1, nullable=False)
    price_alert_above = Column(Float)
    price_alert_below = Column(Float)
    notified_at = Column(DateTime)
    created_at = Column(DateTime, default=func.now())

    card = relationship("Card", back_populates="wishlist_items")

    __table_args__ = (
        CheckConstraint("quantity >= 1 AND quantity <= 99", name="ck_wishlist_quantity_range"),
        UniqueConstraint("user_id", "card_id", name="uq_wishlist_user_card"),
    )


class PriceHistory(Base):
    __tablename__ = "price_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    date = Column(Date, nullable=False)
    price_low = Column(Float)
    price_mid = Column(Float)
    price_high = Column(Float)
    price_market = Column(Float)
    price_trend = Column(Float)

    card = relationship("Card", back_populates="price_history")

    __table_args__ = (UniqueConstraint("card_id", "date", name="uq_price_history_card_date"),)


class Binder(Base):
    __tablename__ = "binders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    description = Column(Text)
    color = Column(String, default="#EE1515")
    binder_type = Column(String, default="collection")  # "collection", "wishlist", "deck" (planned), or "physical_deck"
    format = Column(String, nullable=True)  # "Standard", "Expanded", "Unlimited", "Casual"
    target_size = Column(Integer, nullable=True)
    icon_pokemon_id = Column(Integer, nullable=True)
    is_public = Column(Boolean, default=False, nullable=False)
    auto_owned_set_id = Column(String, nullable=True)
    # Set only when importing Decks created by the original standalone PR #386
    # schema. Keeping the source id makes that data migration idempotent.
    legacy_deck_id = Column(Integer, nullable=True)
    # Pockets a page in book view: 4, 9 or 12 (validated in the API).
    pocket_layout = Column(Integer, default=9, nullable=False, server_default="9")
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    binder_cards = relationship("BinderCard", back_populates="binder", cascade="all, delete-orphan")
    slots = relationship("BinderSlot", back_populates="binder", cascade="all, delete-orphan")

    @property
    def entries(self):
        """Planned deck entries stored in the shared binder-card table."""
        if (self.binder_type or "collection") in {"deck", "physical_deck"}:
            return [entry for entry in self.binder_cards if entry.collection_item_id is None]
        return list(self.binder_cards)

    @property
    def allocations(self):
        """Exact owned copies assigned to this card list."""
        return [entry for entry in self.binder_cards if entry.collection_item_id is not None]

    __table_args__ = (
        CheckConstraint(
            "target_size IS NULL OR target_size IN (20, 40, 60)",
            name="ck_binders_target_size",
        ),
        Index("ux_binders_legacy_deck_id", "legacy_deck_id", unique=True),
    )


class BinderCard(Base):
    __tablename__ = "binder_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    binder_id = Column(Integer, ForeignKey("binders.id"), nullable=False)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    collection_item_id = Column(Integer, ForeignKey("collection.id"), nullable=True)
    required_quantity = Column(Integer, default=1, nullable=False)
    added_at = Column(DateTime, default=func.now())

    binder = relationship("Binder", back_populates="binder_cards")
    card = relationship("Card", back_populates="binder_cards")
    collection_item = relationship("CollectionItem")
    slots = relationship("BinderSlot", back_populates="binder_card", cascade="all, delete-orphan")

    __table_args__ = (
        CheckConstraint("required_quantity >= 1 AND required_quantity <= 99", name="ck_binder_card_quantity_range"),
        UniqueConstraint("binder_id", "collection_item_id", name="uq_binder_collection_item"),
        Index("ix_binder_cards_collection_item_id", "collection_item_id"),
        Index(
            "ix_binder_cards_plan_lookup",
            "binder_id",
            "card_id",
            postgresql_where=collection_item_id.is_(None),
            sqlite_where=collection_item_id.is_(None),
        ),
    )


class BinderSlot(Base):
    """A physical pocket in a binder (book view). One row per placed copy."""

    __tablename__ = "binder_slots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    binder_id = Column(Integer, ForeignKey("binders.id", ondelete="CASCADE"), nullable=False)
    slot_index = Column(Integer, nullable=False)  # page = slot_index // pocket_layout
    binder_card_id = Column(Integer, ForeignKey("binder_cards.id", ondelete="CASCADE"), nullable=False)
    copy_index = Column(Integer, nullable=False, default=0)  # 0 .. required_quantity-1

    binder = relationship("Binder", back_populates="slots")
    binder_card = relationship("BinderCard", back_populates="slots")

    __table_args__ = (
        UniqueConstraint("binder_id", "slot_index", name="uq_binder_slot_index"),
        UniqueConstraint("binder_card_id", "copy_index", name="uq_binder_slot_copy"),
        CheckConstraint("slot_index >= 0 AND copy_index >= 0", name="ck_binder_slot_nonneg"),
    )


class ProductPurchase(Base):
    __tablename__ = "product_purchases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_name = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    product_type = Column(String)  # Booster, Display, ETB, Tin, Bundle, etc.
    purchase_price = Column(Float, nullable=False)
    current_value = Column(Float)
    sold_price = Column(Float)
    purchase_date = Column(Date, nullable=False)
    sold_date = Column(Date)
    lifecycle_status = Column(String, nullable=False, default="sealed", server_default="sealed")
    batch_id = Column(String)
    image_url = Column(String)
    cardmarket_url = Column(String)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("ix_product_purchases_user_id", "user_id"),
        Index("ix_product_purchases_user_batch", "user_id", "batch_id"),
        CheckConstraint(
            "lifecycle_status IN ('sealed', 'opened', 'sold', 'review')",
            name="ck_product_purchases_lifecycle_status",
        ),
    )


class ProductCard(Base):
    __tablename__ = "product_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("product_purchases.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    # Historical source row only. Intentionally not a FK so sold-card history
    # survives when the active collection row is reduced/deleted after sale.
    collection_item_id = Column(Integer, nullable=True)
    initial_quantity = Column(Integer, default=1, nullable=False)
    active_quantity = Column(Integer, default=1, nullable=False)
    sold_quantity = Column(Integer, default=0, nullable=False)
    condition = Column(String, default="NM")
    variant = Column(String, nullable=False, default="Normal")
    lang = Column(String, default="en")
    purchase_price = Column(Float)
    linked_at = Column(DateTime, default=func.now())

    product = relationship("ProductPurchase")
    card = relationship("Card")
    ledger_entries = relationship(
        "ProductLedgerEntry",
        back_populates="product_card",
        order_by="ProductLedgerEntry.event_date.asc(), ProductLedgerEntry.id.asc()",
    )
    printing_detail_tags = relationship(
        "PrintingDetailTag",
        secondary=product_card_printing_detail_tags,
        back_populates="product_cards",
        lazy="selectin",
        order_by="PrintingDetailTag.name",
    )

    @property
    def printing_details(self):
        return [tag.name for tag in self.printing_detail_tags]

    __table_args__ = (
        CheckConstraint("initial_quantity >= 1", name="ck_product_cards_initial_quantity_positive"),
        CheckConstraint("active_quantity >= 0", name="ck_product_cards_active_quantity_non_negative"),
        CheckConstraint("sold_quantity >= 0", name="ck_product_cards_sold_quantity_non_negative"),
        CheckConstraint("active_quantity + sold_quantity <= initial_quantity", name="ck_product_cards_quantities_within_initial"),
        CheckConstraint(COLLECTION_VARIANT_CHECK, name="ck_product_cards_variant"),
    )


class ProductLedgerEntry(Base):
    __tablename__ = "product_ledger_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_card_id = Column(Integer, ForeignKey("product_cards.id", ondelete="SET NULL"), nullable=True)
    product_id = Column(Integer, ForeignKey("product_purchases.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entry_type = Column(String, nullable=False, default="card_sale")  # card_sale / flat_gain / adjustment
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    original_collection_item_id = Column(Integer, nullable=True)
    trade_item_id = Column(Integer, ForeignKey("trade_items.id", ondelete="SET NULL"), nullable=True)
    quantity = Column(Integer, default=1, nullable=False)
    amount = Column(Float, nullable=False)  # Flat total for this ledger event
    event_date = Column(Date, nullable=False)
    product_name = Column(String, nullable=True)
    card_name = Column(String, nullable=True)
    set_id = Column(String, nullable=True)
    card_number = Column(String, nullable=True)
    variant = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    lang = Column(String, nullable=True)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    product_card = relationship("ProductCard", back_populates="ledger_entries")
    product = relationship("ProductPurchase")
    card = relationship("Card")
    printing_detail_tags = relationship(
        "PrintingDetailTag",
        secondary=product_ledger_printing_detail_tags,
        back_populates="product_ledger_entries",
        lazy="selectin",
        order_by="PrintingDetailTag.name",
    )

    @property
    def printing_details(self):
        return [tag.name for tag in self.printing_detail_tags]

    __table_args__ = (
        CheckConstraint("quantity >= 1", name="ck_product_ledger_quantity_positive"),
        CheckConstraint("amount >= 0", name="ck_product_ledger_amount_non_negative"),
        CheckConstraint("entry_type IN ('card_sale', 'flat_gain', 'adjustment', 'trade_out')", name="ck_product_ledger_entry_type"),
        CheckConstraint(
            "variant IS NULL OR " + COLLECTION_VARIANT_CHECK,
            name="ck_product_ledger_variant",
        ),
    )


class Trade(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    partner_name = Column(String, nullable=True)
    trade_date = Column(Date, nullable=False)
    notes = Column(Text)
    outgoing_value = Column(Float, default=0, nullable=False)
    incoming_value = Column(Float, default=0, nullable=False)
    value_delta = Column(Float, default=0, nullable=False)
    # The swap offer this trade was logged from (P11); each side's trade links to it, and through it to the other's.
    swap_offer_id = Column(Integer, ForeignKey("swap_offers.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=func.now())

    items = relationship(
        "TradeItem",
        back_populates="trade",
        cascade="all, delete-orphan",
        order_by="TradeItem.id.asc()",
    )

    __table_args__ = (
        CheckConstraint("outgoing_value >= 0", name="ck_trades_outgoing_value_non_negative"),
        CheckConstraint("incoming_value >= 0", name="ck_trades_incoming_value_non_negative"),
    )


class TradeItem(Base):
    __tablename__ = "trade_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    trade_id = Column(Integer, ForeignKey("trades.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    direction = Column(String, nullable=False)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    original_collection_item_id = Column(Integer, nullable=True)
    created_collection_item_id = Column(Integer, nullable=True)
    product_card_id = Column(Integer, nullable=True)
    # Inventory provenance added for editable trades. Legacy rows keep
    # snapshot_version=0 so unsafe reversals can be rejected explicitly.
    purchase_price = Column(Float, nullable=True)
    snapshot_version = Column(Integer, default=1, nullable=False)
    quantity = Column(Integer, default=1, nullable=False)
    value_per_card = Column(Float, default=0, nullable=False)
    value_total = Column(Float, default=0, nullable=False)
    card_name = Column(String, nullable=True)
    set_id = Column(String, nullable=True)
    card_number = Column(String, nullable=True)
    variant = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    lang = Column(String, nullable=True)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    trade = relationship("Trade", back_populates="items")
    card = relationship("Card")
    printing_detail_tags = relationship(
        "PrintingDetailTag",
        secondary=trade_item_printing_detail_tags,
        back_populates="trade_items",
        lazy="selectin",
        order_by="PrintingDetailTag.name",
    )

    @property
    def printing_details(self):
        return [tag.name for tag in self.printing_detail_tags]

    __table_args__ = (
        CheckConstraint("direction IN ('outgoing', 'incoming')", name="ck_trade_items_direction"),
        CheckConstraint("quantity >= 1", name="ck_trade_items_quantity_positive"),
        CheckConstraint("value_per_card >= 0", name="ck_trade_items_value_per_card_non_negative"),
        CheckConstraint("value_total >= 0", name="ck_trade_items_value_total_non_negative"),
        CheckConstraint("purchase_price IS NULL OR purchase_price >= 0", name="ck_trade_items_purchase_price_non_negative"),
        CheckConstraint("snapshot_version >= 0", name="ck_trade_items_snapshot_version_non_negative"),
        CheckConstraint(
            "variant IS NULL OR " + COLLECTION_VARIANT_CHECK,
            name="ck_trade_items_variant",
        ),
    )


class SyncLog(Base):
    __tablename__ = "sync_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=func.now())
    finished_at = Column(DateTime)
    cards_updated = Column(Integer, default=0)
    sets_updated = Column(Integer, default=0)
    status = Column(String, default="running")  # running/success/error
    error_message = Column(Text)
    sync_type = Column(String, nullable=True, default="full")  # "full" or "price"
    retry_summary = Column(Text, nullable=True)  # JSON {retried, recovered, still_failing, permanent}


class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(DateTime, nullable=False)  # full UTC timestamp, no unique constraint
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    total_value = Column(Float, default=0)
    total_cards = Column(Integer, default=0)
    total_cost = Column(Float, default=0)
    calculation_version = Column(Integer, default=PORTFOLIO_CALCULATION_VERSION, nullable=False)
    cards_value = Column(Float, nullable=True)
    products_value = Column(Float, nullable=True)
    cards_cost = Column(Float, nullable=True)
    products_cost = Column(Float, nullable=True)
    performance_cost_basis = Column(Float, nullable=True)
    realized_value = Column(Float, nullable=True)
    unrealized_pnl = Column(Float, nullable=True)
    realized_pnl = Column(Float, nullable=True)
    total_pnl = Column(Float, nullable=True)
    product_value_fallback_count = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_portfolio_snapshots_user_date", "user_id", "date"),
    )


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)


class UserSetting(Base):
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_setting"),)


class CustomCardMatch(Base):
    """Tracks custom cards that now have an equivalent API card on TCGdex."""
    __tablename__ = "custom_card_matches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    custom_card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    api_card_id = Column(String, nullable=False)
    matched_at = Column(DateTime, default=func.now())
    status = Column(String, default="pending")  # pending / migrated / dismissed

    custom_card = relationship("Card", foreign_keys=[custom_card_id])


class ImageCache(Base):
    __tablename__ = "image_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    image_key = Column(String, unique=True, nullable=False, index=True)
    data = Column(LargeBinary, nullable=False)
    content_type = Column(String, default="image/webp")
    cached_at = Column(DateTime, default=func.now())


class ScanJob(Base):
    """A persistent background-recognition job owned by one user."""

    __tablename__ = "scan_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String, default="pending", nullable=False, index=True)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), nullable=False)
    started_at = Column(DateTime)
    finished_at = Column(DateTime)
    expires_at = Column(DateTime, nullable=False, index=True)
    error_message = Column(Text)

    items = relationship(
        "ScanJobItem",
        back_populates="job",
        cascade="all, delete-orphan",
        order_by="ScanJobItem.position",
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'running', 'done', 'failed')",
            name="ck_scan_jobs_status",
        ),
        Index("ix_scan_jobs_user_status_created", "user_id", "status", "created_at"),
    )


class ScanJobItem(Base):
    """One sanitized photo and its eventual recognition result."""

    __tablename__ = "scan_job_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("scan_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    image_path = Column(String, nullable=True)
    content_type = Column(String, default="image/jpeg", nullable=False)
    byte_size = Column(Integer, nullable=False)
    batch_mode = Column(Boolean, default=False, nullable=False)
    status = Column(String, default="pending", nullable=False, index=True)
    resolved = Column(Boolean, default=False, nullable=False, index=True)
    attempts = Column(Integer, default=0, nullable=False)
    transient_failures = Column(Integer, default=0, nullable=False)
    next_attempt_at = Column(DateTime, nullable=True, index=True)
    retry_reason = Column(String, nullable=True)
    lease_token = Column(String, nullable=True, index=True)
    lease_expires_at = Column(DateTime, nullable=True, index=True)
    recognized = Column(JSON)
    matches = Column(JSON)
    error = Column(Text)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    updated_at = Column(DateTime, default=func.now(), nullable=False)

    job = relationship("ScanJob", back_populates="items")

    __table_args__ = (
        UniqueConstraint("job_id", "position", name="uq_scan_job_item_position"),
        CheckConstraint(
            "status IN ('pending', 'processing', 'retrying', 'done', 'failed')",
            name="ck_scan_job_items_status",
        ),
        CheckConstraint("attempts >= 0", name="ck_scan_job_items_attempts_non_negative"),
        CheckConstraint(
            "transient_failures >= 0",
            name="ck_scan_job_items_transient_failures_non_negative",
        ),
        Index(
            "ix_scan_job_items_dispatch",
            "status",
            "next_attempt_at",
            "lease_expires_at",
            "user_id",
        ),
    )


class ScanQueueUserState(Base):
    """Persistent round-robin cursor used to share queue work fairly."""

    __tablename__ = "scan_queue_user_state"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_dispatched_at = Column(DateTime, nullable=True, index=True)


class IdempotencyKey(Base):
    """A completed, replayable result for one (user, Idempotency-Key). Only 2xx results are stored."""

    __tablename__ = "idempotency_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key = Column(String(64), nullable=False)
    scope = Column(String(64), nullable=False)
    request_hash = Column(String(64), nullable=False)          # sha256 hex
    response_status = Column(Integer, nullable=False)
    response_body = Column(IDEMPOTENCY_JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    expires_at = Column(DateTime, nullable=False, index=True)

    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_idempotency_user_key"),)


class PushSubscription(Base):
    """One Web Push subscription (one browser/device) of a user."""

    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(String(255), nullable=False)
    auth = Column(String(255), nullable=False)
    user_agent = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())
    last_seen_at = Column(DateTime, nullable=False, default=func.now())
    last_success_at = Column(DateTime, nullable=True)
    failure_count = Column(Integer, nullable=False, default=0)

    __table_args__ = (UniqueConstraint("endpoint", name="uq_push_subscription_endpoint"),)


class GeminiQuotaState(Base):
    """Cross-worker pacing state keyed by a non-reversible API-key fingerprint."""

    __tablename__ = "gemini_quota_state"

    key_fingerprint = Column(String, primary_key=True)
    tokens = Column(Float, nullable=True)
    last_refill_at = Column(DateTime, nullable=True)
    next_request_at = Column(DateTime, nullable=True, index=True)
    blocked_until = Column(DateTime, nullable=True)
    blocked_reason = Column(String, nullable=True)
    consecutive_daily_failures = Column(Integer, default=0, nullable=False)
    interactive_pending_until = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=func.now(), nullable=False)


class ScannerProviderLimitState(Base):
    """Persisted non-Gemini provider blocks without storing credentials or URLs."""

    __tablename__ = "scanner_provider_limit_state"

    scope_fingerprint = Column(String, primary_key=True)
    provider = Column(String, nullable=False)
    blocked_until = Column(DateTime, nullable=True, index=True)
    blocked_reason = Column(String, nullable=True)
    updated_at = Column(DateTime, default=func.now(), nullable=False)


class ProgressState(Base):
    """The progress evaluator's memory, one row per user."""

    __tablename__ = "progress_state"

    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    evaluated_at = Column(DateTime, nullable=True)
    dirty_at = Column(DateTime, nullable=True, index=True)
    completed_sets = Column(JSON, nullable=False, default=list)
    last_seen_collection_id = Column(Integer, nullable=False, default=0)
    state_version = Column(Integer, nullable=False, default=1)


class UserEvent(Base):
    """Something that happened to a trainer; written by the evaluator and later services."""

    __tablename__ = "user_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(40), nullable=False)
    occurred_at = Column(DateTime, nullable=False, index=True, default=func.now())
    subject_key = Column(String(160), nullable=True)
    payload = Column(JSON, nullable=False, default=dict)
    dedupe_key = Column(String(200), nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "dedupe_key", name="uq_user_event_dedupe"),)


class EventReaction(Base):
    """A one-tap reaction from one trainer to another trainer's feed event (docs/ENGAGEMENT_DESIGN.md P12)."""

    __tablename__ = "event_reactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(Integer, ForeignKey("user_events.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(24), nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (UniqueConstraint("event_id", "user_id", "kind", name="uq_event_reaction"),)


class UserGoal(Base):
    """A chase goal: a rule over the catalogue (a set, a generation, a family, an artist, a card list)."""

    __tablename__ = "user_goals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(24), nullable=False)
    params = Column(JSON, nullable=False, default=dict)
    pinned = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(DateTime, nullable=False, default=func.now(), onupdate=func.now())
    completed_at = Column(DateTime, nullable=True)
    # Milestone thresholds (50/75/90/100) already recorded; NULL until the first evaluation backfills them silently.
    milestones = Column(JSON, nullable=True)


class UserDailyActivity(Base):
    """One row per user per local day the app was opened."""

    __tablename__ = "user_daily_activity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    local_date = Column(Date, nullable=False)
    first_seen_at = Column(DateTime, nullable=False, default=func.now())
    last_seen_at = Column(DateTime, nullable=False, default=func.now())
    opens = Column(Integer, nullable=False, default=1)
    offline = Column(Boolean, nullable=False, default=False)
    data = Column(JSON, nullable=False, default=dict)

    __table_args__ = (UniqueConstraint("user_id", "local_date", name="uq_user_daily_activity"),)


class UserAchievement(Base):
    __tablename__ = "user_achievements"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    achievement_id = Column(String(64), nullable=False)
    unlocked_at = Column(DateTime, nullable=False, default=func.now())
    seen_at = Column(DateTime, nullable=True)
    notified_at = Column(DateTime, nullable=True)
    backfilled = Column(Boolean, nullable=False, default=False)

    __table_args__ = (UniqueConstraint("user_id", "achievement_id", name="uq_user_achievement"),)


class UserXpLedger(Base):
    """Experience points, one row per award. The unique (user, source, source_key) makes awards idempotent."""

    __tablename__ = "user_xp_ledger"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    source = Column(String(24), nullable=False)
    source_key = Column(String(160), nullable=False)
    amount = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    # When the trainer saw the celebration for this award (quest awards only); NULL until then.
    seen_at = Column(DateTime, nullable=True)

    __table_args__ = (UniqueConstraint("user_id", "source", "source_key", name="uq_user_xp_ledger_source"),)


class NotificationQueue(Base):
    """A notification waiting to go out: instant ones wait for quiet hours to end, digest ones for the digest."""

    __tablename__ = "notification_queue"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category = Column(String(40), nullable=False)
    subject_key = Column(String(160), nullable=False)
    created_at = Column(DateTime, nullable=False, default=func.now())
    send_after = Column(DateTime, nullable=False, default=func.now())
    sent_at = Column(DateTime, nullable=True, index=True)
    # What the event was about, as it was when it happened (card name, prices, badge id, ...).
    # Read when the push is built; NULL for rows queued before this column existed.
    details = Column(JSON, nullable=True)

    __table_args__ = (Index("ix_notification_queue_subject", "user_id", "category", "subject_key"),)


class SwapOffer(Base):
    """A card swap between two trainers (P11): proposed, countered, accepted, then both tap "Swapped"."""

    __tablename__ = "swap_offers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    from_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    to_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # proposed, countered, accepted, completed, declined, cancelled, expired
    state = Column(String(16), nullable=False, default="proposed")
    # Whose move it is while proposed or countered; NULL once accepted or finished.
    turn_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    cash_amount = Column(Float, nullable=False, default=0)
    cash_payer_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    note = Column(String(140), nullable=True)
    expires_at = Column(DateTime, nullable=False)
    from_confirmed_at = Column(DateTime, nullable=True)
    to_confirmed_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(DateTime, nullable=False, default=func.now())

    items = relationship(
        "SwapOfferItem",
        back_populates="offer",
        cascade="all, delete-orphan",
        order_by="SwapOfferItem.id.asc()",
    )

    __table_args__ = (
        CheckConstraint("cash_amount >= 0", name="ck_swap_offers_cash_non_negative"),
        Index("ix_swap_offers_state_expires", "state", "expires_at"),
    )


class SwapOfferItem(Base):
    """One copy (or part of a stack) on the table; replaced wholesale by a counter."""

    __tablename__ = "swap_offer_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    offer_id = Column(Integer, ForeignKey("swap_offers.id", ondelete="CASCADE"), nullable=False, index=True)
    giver_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Not a foreign key: the copy is gone after the swap.
    collection_item_id = Column(Integer, nullable=True)
    card_id = Column(String, nullable=True)
    variant = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    lang = Column(String, nullable=True)
    quantity = Column(Integer, nullable=False, default=1)
    card_name = Column(String, nullable=True)
    set_id = Column(String, nullable=True)
    card_number = Column(String, nullable=True)
    value_per_card = Column(Float, nullable=False, default=0)

    offer = relationship("SwapOffer", back_populates="items")

    __table_args__ = (CheckConstraint("quantity >= 1", name="ck_swap_offer_items_quantity"),)
