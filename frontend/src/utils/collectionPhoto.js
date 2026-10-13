import { uploadCollectionItemPhoto } from '../api/client'

// Saves `photo` as the owner's private photo of a freshly added collection item.
//
// A photo the user chose or deliberately kept (`overwrite`) replaces whatever is
// stored. An automatic one — the scan taken to identify the card — never does:
// grouping into an existing row is common, and a second scan of the same card is
// not necessarily a better photo than the one already saved.
//
// Best-effort: the card is already in the collection, so a failed upload returns
// false instead of throwing.
export async function attachCollectionPhoto({
  created,
  photo,
  overwrite = false,
  uploadPhoto = uploadCollectionItemPhoto,
}) {
  if (!photo || !created?.id) return false
  if (created.has_scan_photo && !overwrite) return false
  try {
    await uploadPhoto(created.id, photo)
    return true
  } catch {
    return false
  }
}
