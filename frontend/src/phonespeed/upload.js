/** The request body for POST /card-match/phone-speed: JSON for the built-in sample (no image at all), multipart with the
 *  photo taken or picked on the page otherwise. Only timings, device facts and the phone's answer go in the JSON. */
export function speedRunRequest(outcome, photoFile) {
  const data = { timings: outcome.timings, device: outcome.device, answer: outcome.answer }
  if (!photoFile) return { body: data, multipart: false }
  const form = new FormData()
  form.append('data', JSON.stringify(data))
  form.append('photo', photoFile, photoFile.name || 'photo.jpg')
  return { body: form, multipart: true }
}
