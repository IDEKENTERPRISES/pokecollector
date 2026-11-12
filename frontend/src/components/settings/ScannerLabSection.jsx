import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { FlaskConical, GitCompare, Hammer, Smartphone } from 'lucide-react'
import api from '../../api/client'
import Misses, { DecidedWrong } from './ScannerLabMisses'
import { describeIos } from '../../phonespeed/plan'

const QUERY_KEY = ['card-match-status']
const SHADOW_KEY = ['card-match-shadow']
const button = 'inline-flex min-h-[32px] flex-shrink-0 items-center gap-1.5 rounded-full bg-accent/20 px-3.5 text-subheadline font-semibold text-tint ios-press disabled:opacity-40'

const number = value => (value === null || value === undefined ? '–' : Number(value).toLocaleString())
const percent = value => (value === null || value === undefined ? '–' : `${value}%`)

function duration(seconds) {
  if (seconds === null || seconds === undefined) return null
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

function Row({ label, value, testId }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" data-testid={testId}>
      <span className="text-footnote text-text-secondary">{label}</span>
      <span className="text-subheadline tabular-nums">{value}</span>
    </div>
  )
}

function PassBar({ items }) {
  return (
    <ul className="space-y-1" data-testid="scanner-lab-pass-bar">
      {items.map(item => (
        <li key={item.id} className="flex items-baseline justify-between gap-3 text-footnote">
          <span className="min-w-0 flex-1">
            <span aria-hidden="true">{item.ok === null ? '·' : item.ok ? '✓' : '✗'}</span>{' '}
            <span className="sr-only">{item.ok === null ? 'not measured' : item.ok ? 'passes' : 'fails'}: </span>
            {item.label}
          </span>
          <span className="tabular-nums text-text-secondary">
            {number(item.value)} <span className="opacity-70">(need {item.target})</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

const GROUP_HEAD = (
  <tr className="text-left text-text-secondary">
    <th className="pr-2 font-normal">Group</th><th className="pr-2 font-normal">Scans</th><th className="pr-2 font-normal">Top 1</th>
    <th className="pr-2 font-normal">Top 20</th><th className="pr-2 font-normal">Decided</th><th className="font-normal">Right</th>
  </tr>
)

function GroupRow({ name, g }) {
  return (
    <tr className="tabular-nums">
      <td className="pr-2">{name}</td>
      <td className="pr-2">{g.n}</td><td className="pr-2">{percent(g.top1)}</td><td className="pr-2">{percent(g.top20)}</td>
      <td className="pr-2">{percent(g.decided)}</td><td>{percent(g.decided_right)}{g.decided_wrong ? ` (${g.decided_wrong} wrong)` : ''}</td>
    </tr>
  )
}

/** Real scans split by when they were made: the ones used for tuning, and the new ones that were not (the fair test). */
export function BatchGroups({ groups }) {
  if (!groups) return null
  return (
    <div data-testid="scanner-lab-batch-groups">
      <h4 className="text-footnote font-semibold">Used for tuning, and new scans</h4>
      <table className="w-full text-footnote">
        <thead>{GROUP_HEAD}</thead>
        <tbody>
          {groups.tuning && <GroupRow name="Used for tuning" g={groups.tuning} />}
          {groups.new && <GroupRow name="New scans, not used for tuning" g={groups.new} />}
        </tbody>
      </table>
      {!groups.new && (
        <p className="text-footnote text-text-secondary" data-testid="scanner-lab-no-new">
          No new scans yet, so there is nothing to show for them. They were not used for tuning, so once they exist they are the fair test.
        </p>
      )}
      {!groups.tuning && <p className="text-footnote text-text-secondary">No scans used for tuning in this run.</p>}
    </div>
  )
}

const trainerCount = n => `${number(n)} ${n === 1 ? 'trainer' : 'trainers'}`

/** One line per read-only source (prod's stored scans): readable or not, and why in plain words, how many scans, how many confirmed, the newest date. */
export function TraceSources({ sources }) {
  if (!sources?.length) return null
  return (
    <div className="space-y-0.5" data-testid="scanner-lab-trace-sources">
      {sources.map(source => (
        <p key={source.label} className="text-footnote" data-testid={`scanner-lab-source-${source.label}`}>
          <span className="text-text-secondary">Scans from {source.label}: </span>
          {source.readable
            ? `readable · ${number(source.scans)} scans, ${number(source.confirmed)} confirmed${source.newest ? `, newest from ${source.newest}` : ''}`
            : `not readable: ${source.reason || 'unknown reason'}`}
        </p>
      ))}
    </div>
  )
}

/** Scans from a read-only source (prod), apart from your own: the ones tuning may use and the held-back ones, with how many trainers they come from. */
export function SourceGroups({ groups, note }) {
  const rows = Object.entries(groups || {}).filter(([name]) => name !== 'local')
  if (!rows.length) return null
  return (
    <div data-testid="scanner-lab-source-groups">
      <h4 className="text-footnote font-semibold">Scans from prod</h4>
      <table className="w-full text-footnote">
        <thead>
          <tr className="text-left text-text-secondary">
            <th className="pr-2 font-normal">Group</th><th className="pr-2 font-normal">Scans</th><th className="pr-2 font-normal">Trainers</th>
            <th className="pr-2 font-normal">Top 1</th><th className="pr-2 font-normal">Top 20</th><th className="pr-2 font-normal">Decided</th><th className="font-normal">Right</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, g]) => (
            <tr key={name} className="tabular-nums" data-testid={`scanner-lab-group-${name}`}>
              <td className="pr-2">{g.label || name}</td><td className="pr-2">{g.n}</td><td className="pr-2">{g.trainers}</td>
              <td className="pr-2">{percent(g.top1)}</td><td className="pr-2">{percent(g.top20)}</td><td className="pr-2">{percent(g.decided)}</td>
              <td>{percent(g.decided_right)}{g.decided_wrong ? ` (${g.decided_wrong} wrong)` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="text-footnote text-text-secondary">{note}</p>}
    </div>
  )
}

const REASON_NAMES = {
  rules_choice_not_close_in_picture: 'The number says one card, but its picture is not close enough',
  number_matches_several_printings: 'The number fits several printings and the picture cannot split them',
  number_not_among_picture_matches: 'The number read is on none of the close pictures',
  no_number_and_picture_not_clear: 'No number read and the picture is not clear enough',
  number_lookup_conflicts_with_name: 'The number and the name point at different cards',
  card_not_found_no_number_read: 'Card not found and no number read from it',
  total_contradicts_read: 'The set total read is not the total this card prints',
  closer_printing_of_same_name: 'Another printing of the same name is clearly closer in the picture',
  no_picture_matches: 'No picture matches',
}

/** Scans where the first pick is right but nothing was decided, by reason: what holds back "decided". */
export function UndecidedReasons({ data }) {
  if (!data) return null
  const rows = [['all', 'All scans'], ['new', 'New scans, not used for tuning'], ['tuning', 'Used for tuning']].filter(([key]) => data[key]?.scans)
  return (
    <div data-testid="scanner-lab-undecided">
      <h4 className="text-footnote font-semibold">Right first pick, but not decided</h4>
      {rows.map(([key, label]) => (
        <div key={key}>
          <p className="text-footnote">{label}: {number(data[key].undecided)} of {number(data[key].first_right)} scans with the right first pick</p>
          {data[key].reasons.length > 0 && (
            <ul className="text-footnote text-text-secondary">
              {data[key].reasons.map(item => <li key={item.reason}>{item.n} · {REASON_NAMES[item.reason] || item.reason.replace(/_/g, ' ')}</li>)}
            </ul>
          )}
        </div>
      ))}
      <p className="text-footnote text-text-secondary">Only counted here; no rule was relaxed.</p>
    </div>
  )
}

/** Scans where the card was not found on the photo the matcher looks at (the fallbacks). */
export function FallbackGroups({ data }) {
  if (!data) return null
  const kinds = [['review_photo', 'Found on the whole review photo'], ['full_photo', 'Found on the full photo'], ['guide_crop', 'Read from the guide frame']]
  return (
    <div data-testid="scanner-lab-fallback">
      <h4 className="text-footnote font-semibold">When the card was not found ({number(data.scans)} scans)</h4>
      {data.scans > 0 ? (
        <table className="w-full text-footnote">
          <thead>{GROUP_HEAD}</thead>
          <tbody>
            {kinds.filter(([key]) => data.by_kind?.[key]).map(([key, label]) => <GroupRow key={key} name={label} g={data.by_kind[key]} />)}
            {data.found_on_photo && <GroupRow name="Card found normally" g={data.found_on_photo} />}
          </tbody>
        </table>
      ) : (
        <p className="text-footnote text-text-secondary">The card was found on every scan.</p>
      )}
      <p className="text-footnote text-text-secondary">
        These scans are listed under “Card not found: read by fallback” in Misses. The whole review photo is tried first, then the full photo, then the guide frame (read once, with the short reading steps). A card found by any of these is only decided when a number was read from it and the picture agrees.
      </p>
    </div>
  )
}

const REFUSED_NAMES = { too_small: 'too small a part of the picture', sideways: 'turned on its side', not_rectangular: 'not rectangular', bad_angles: 'corners far from square' }
const spread = value => (value ? `${value.min} to ${value.max}, typically ${value.median}` : '–')

const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : null)

/** The corners check (real scans only): which cut-out is closer to the confirmed card’s own catalogue picture, the finder’s or the plain guide frame. */
export function CornersCheck({ data }) {
  if (!data || !data.all?.scans) return null
  const rows = [['all', 'All scans'], ['tuning', 'Used for tuning'], ['new', 'New scans, not used for tuning']].filter(([key]) => data[key]?.scans)
  const g = data.all
  return (
    <div className="space-y-1" data-testid="scanner-lab-corners">
      <h4 className="text-footnote font-semibold">Which cut-out is closer to the catalogue picture? ({number(g.scans)} scans)</h4>
      <p className="text-footnote text-text-secondary">
        For each scan, the card the finder cut out and the plain guide frame were each compared with the confirmed card’s own catalogue picture. “Guide frame closer” counts scans where the guide frame was closer by at least {data.margin} (on a 0 to 1 scale).
        It only says which cut-out looks more like the catalogue picture: those finder cut-outs look like normal ones, and it is not a count of broken scans. Read it as a ranking signal.
      </p>
      {(() => {
        const withCard = g.scans - g.no_quad
        const inGroup = pct(g.spoiled_no_number, g.spoiled)
        const overall = pct(g.no_number_all, withCard)
        if (inGroup == null || overall == null) return null
        return (
          <p className="text-footnote text-text-secondary" data-testid="scanner-lab-corners-number-rate">
            In that group the number was not read in {inGroup}% of the scans ({number(g.spoiled_no_number)} of {number(g.spoiled)}); across all {number(withCard)} scans with a card found it was not read in {overall}% ({number(g.no_number_all)}).
            {Math.abs(inGroup - overall) <= 5 ? ' That is about the same, so this group does not predict a missed number.' : inGroup > overall ? ' That is higher than for all scans.' : ' That is lower than for all scans.'}
          </p>
        )
      })()}
      <table className="w-full text-footnote">
        <thead>
          <tr className="text-left text-text-secondary">
            <th className="pr-2 font-normal">Scans</th><th className="pr-2 font-normal">Measured</th><th className="pr-2 font-normal">Guide frame closer</th>
            <th className="pr-2 font-normal">… no number read</th><th className="font-normal">Whole picture closer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, label]) => (
            <tr key={key} className="tabular-nums">
              <td className="pr-2">{label}</td><td className="pr-2">{number(data[key].scans)}</td><td className="pr-2">{number(data[key].spoiled)}</td>
              <td className="pr-2">{number(data[key].spoiled_no_number)}</td><td>{number(data[key].whole_better)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {g.spoiled > 0 && (
        <p className="text-footnote text-text-secondary" data-testid="scanner-lab-corners-shape">
          In those scans the finder’s cut-out covers {spread(g.coverage)} of the picture (the others: {spread(g.coverage_of_the_rest)}); shape error against a card {spread(g.ratio_error)}; widest corner angle off square {spread(g.angle_deviation)}°.
          Where the guide frame is closer it is closer by {g.mean_gain} on average. This version’s finder refuses {number(g.refused_among_spoiled)} of the {number(g.spoiled)}.
        </p>
      )}
      {g.no_quad > 0 && <p className="text-footnote text-text-secondary">{number(g.no_quad)} scans had no card found at all and are not in these counts.</p>}
      {data.sets?.some(item => item.spoiled) && (
        <p className="text-footnote text-text-secondary" data-testid="scanner-lab-corners-sets">
          Guide frame closer, by set: {data.sets.filter(item => item.spoiled).map(item => `${item.set} ${item.spoiled} of ${item.scans}`).join(' · ')}
        </p>
      )}
      {Object.keys(data.refused_reasons || {}).length > 0 && (
        <p className="text-footnote text-text-secondary">
          Quads this finder refused: {Object.entries(data.refused_reasons).map(([key, n]) => `${n} ${REFUSED_NAMES[key] || key}`).join(' · ')}.
        </p>
      )}
      <p className="text-footnote text-text-secondary">These scans are tagged “Corners off” in Misses, with the measurements.</p>
    </div>
  )
}

export function Report({ report, title }) {
  const m = report.metrics
  const timings = report.timings_ms || {}
  return (
    <div className="space-y-3 border-t border-separator px-4 py-3" data-testid={`scanner-lab-report-${report.kind}`}>
      <div>
        <h3 className="text-subheadline font-semibold">{title}</h3>
        <p className="text-footnote text-text-secondary">
          {number(m.n)} photos · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)} · {report.host?.threads} threads on {report.host?.cpu_count} cores
        </p>
        {report.kind === 'synthetic' && (
          <p className="text-footnote text-text-secondary">{report.note}</p>
        )}
      </div>
      <PassBar items={report.pass_bar || []} />
      <div>
        <Row label="Card found" value={`${percent(m.card_found_pct)}${m.card_found_accurate_pct != null ? ` (corners right ${percent(m.card_found_accurate_pct)})` : ''}`} />
        <Row label="Right printing: top 1 / top 5 / top 20" value={`${percent(m.top1_pct)} / ${percent(m.top5_pct)} / ${percent(m.top20_pct)}`} />
        <Row label="Number read exactly" value={percent(m.number_exact_pct)} />
        {m.total_exact_pct != null && <Row label="Set total read exactly" value={percent(m.total_exact_pct)} />}
        <Row label="Decided without a model" value={percent(m.decided_pct)} />
        <Row label="Of those, right" value={`${percent(m.decided_right_pct)} (${number(m.decided_wrong)} wrong)`} />
      </div>
      {report.kind === 'labelled' && <BatchGroups groups={report.by_scan_time} />}
      {report.kind === 'labelled' && <SourceGroups groups={report.by_group} note={report.held_back_note} />}
      {report.kind === 'labelled' && <UndecidedReasons data={report.undecided_first_right} />}
      {report.kind === 'labelled' && <FallbackGroups data={report.fallback} />}
      {report.kind === 'labelled' && <CornersCheck data={report.corners_check} />}
      {report.groups && Object.keys(report.groups).length > 0 && (
        <table className="w-full text-footnote">
          <thead>
            <tr className="text-left text-text-secondary">
              <th className="font-normal">Group</th><th className="font-normal">n</th><th className="font-normal">Top 1</th><th className="font-normal">Top 20</th><th className="font-normal">Decided</th><th className="font-normal">Right</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(report.groups).map(([name, g]) => (
              <tr key={name} className="tabular-nums">
                <td>{{ trap: 'Reprint traps', holo: 'Holo / full art', plain: 'Other' }[name] || name}</td>
                <td>{g.n}</td><td>{percent(g.top1)}</td><td>{percent(g.top20)}</td><td>{percent(g.decided)}</td><td>{percent(g.decided_right)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="w-full text-footnote" data-testid="scanner-lab-timings">
        <thead>
          <tr className="text-left text-text-secondary"><th className="font-normal">Stage</th><th className="font-normal">Median</th><th className="font-normal">95th</th></tr>
        </thead>
        <tbody>
          {Object.entries(timings).map(([stage, row]) => (
            <tr key={stage} className={stage === 'total' ? 'font-semibold tabular-nums' : 'tabular-nums'}>
              <td>{stage}</td><td>{row.median} ms</td><td>{row.p95} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-footnote text-text-secondary">
        Memory: {report.memory?.extra_mb != null ? `${number(report.memory.extra_mb)} MB extra (peak ${number(report.memory.peak_rss_mb)} MB)` : 'not measured on this host'}
        {' · '}Index: {number(report.index?.count)} pictures{report.index?.build_seconds != null ? `, built in ${duration(report.index.build_seconds)}` : ''}
      </p>
      {report.ollama_today && (
        <div data-testid="scanner-lab-ollama">
          <h4 className="text-footnote font-semibold">What today’s Ollama path got on the {number(report.ollama_today.n)} photos where it ran</h4>
          {report.ollama_today.not_run > 0 && (
            <p className="text-footnote text-text-secondary">{number(report.ollama_today.not_run)} more were decided by the picture first, so Ollama never saw them and they are not counted here.</p>
          )}
          <Row label="Decided" value={percent(report.ollama_today.decided_pct)} />
          <Row label="Of those, right" value={percent(report.ollama_today.decided_right_pct)} />
          <Row label="Right card among its candidates" value={percent(report.ollama_today.in_candidates_pct)} />
          <Row label="Right card ranked first" value={percent(report.ollama_today.top1_pct)} />
        </div>
      )}
      {report.side_by_side && <SideBySide data={report.side_by_side} />}
    </div>
  )
}

const OPTION_NAMES = { baseline: 'Picture only', names: 'Name search', number: 'number lookup', text: 'card text', reprint: 'reprint tie-break', tta: 'extra views', art: 'artwork', base: 'DINOv2-base', numberonce: 'one number boost', fastread: 'faster reading', corners: 'self-doubting card finder', wholepic: 'whole picture when corners are refused', trustrejected: 'normal rules when corners are refused', wholeread: 'second read of the whole picture', wholestrict: 'stricter rules for a number read only from the whole picture', phone8: 'phone: 8-bit model', index8: 'phone: 8-bit index', fp16: 'phone: 16-bit model' }
const isPhoneLabel = label => /(^|\+)(phone8|index8|fp16)(\+|$)/.test(label || '')
const megabytes = bytes => (bytes == null ? '–' : `${(bytes / 1048576).toFixed(1)} MB`)
const describeOptions = label => (label === 'baseline' ? OPTION_NAMES.baseline : label.split('+').map(word => OPTION_NAMES[word] || word).join(' + '))

/** The scans one comparison row decided wrong, in the same plain wording as Misses > Decided wrong (text only: no pictures are kept for these). */
export function WrongList({ row }) {
  const items = row.wrong_scans || []
  return (
    <div className="space-y-1.5 rounded-md bg-fill px-2 py-2" data-testid="scanner-lab-row-wrong">
      <p className="text-footnote font-semibold">Decided wrong with {describeOptions(row.label)}</p>
      {items.length === 0 ? (
        <p className="text-footnote text-text-secondary">{row.decided_wrong ? 'This run did not keep the details of its wrong decisions (it ran before they were kept).' : 'Nothing was decided wrong.'}</p>
      ) : (
        items.map((item, position) => <DecidedWrong key={`${item.key}-${position}`} item={item} />)
      )}
      {items.length > 0 && items.length < row.decided_wrong && <p className="text-footnote text-text-secondary">Showing the first {items.length} of {row.decided_wrong}.</p>}
    </div>
  )
}

/** The option sets side by side on the same photos: pick the row with the best top 20 and decided rate with 0 wrong. */
export function PhoneNote({ phone, rows }) {
  if (!phone || !(rows || []).some(row => isPhoneLabel(row.label))) return null
  const indexes = Object.values(phone.indexes || {})
  const built = indexes.filter(item => item.built)
  return (
    <p className="text-footnote text-text-secondary" data-testid="scanner-lab-phone-note">
      Phone settings: rows marked "phone" run the matcher the way the iPhone will and are never picked as the server's own set.
      The 8-bit model is {megabytes(phone.model?.size_bytes)} (full {megabytes(phone.model?.fp32_size_bytes)}, 16-bit {megabytes(phone.model?.fp16_size_bytes)}).
      {built.length > 0 ? ` Its indexes on the server: ${built.map(item => `${number(item.count)} pictures, ${megabytes(item.size_bytes)}`).join(' and ')} (the phone stores them as 8-bit numbers, about a quarter of that).` : ' Its indexes are not built yet.'}
      {phone.bundle?.built ? ` Phone bundle: ${megabytes(phone.bundle.total_bytes)} in ${number(phone.bundle.files)} files.` : ' The phone bundle is not built yet.'}
    </p>
  )
}

const SPEED_KEY = ['card-match-phone-speed']

/** The photo of a speed-test run as a small thumbnail. Admin-only: fetched with the sign-in token, never a public URL. */
function RunThumb({ id }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let live = true
    let made = null
    api.get(`/card-match/phone-speed/${id}/photo`, { responseType: 'blob' }).then(response => {
      if (!live) return
      made = URL.createObjectURL(response.data)
      setUrl(made)
    }).catch(() => {})
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [id])
  if (!url) return <span className="inline-block h-12 w-9 flex-shrink-0 rounded bg-separator" aria-hidden="true" />
  return <img src={url} alt="Speed-test photo (admins only)" className="h-12 w-auto flex-shrink-0 rounded" draggable={false} data-testid="scanner-lab-phone-speed-thumb" />
}

/** "Phone and server agree" for one run, from the server's comparison (the numbers the API worked out). */
export function agreementText(run) {
  const server = run.server || {}
  if (!run.has_photo) return 'no photo (built-in sample)'
  if (server.status === 'pending') return 'server comparison running…'
  const compare = run.compare
  if (!compare) return server.in_use?.status === 'error' ? `server could not compare: ${server.in_use.error}` : 'no server comparison'
  const parts = []
  const way = compare.phone_way
  if (way) {
    const [backend, item] = Object.entries(way.backends || {})[0] || []
    if (item) {
      const lists = ['whole', 'art'].filter(kind => item[kind]).map(kind => `${kind} ${item[kind].overlap}/20 shared${item[kind].top1_agree ? ', top 1 agrees' : ''}`)
      const way_up = way.orientation_agree === false ? ' · PHOTO TURNED DIFFERENTLY' : ''
      parts.push(`like-for-like (${backend}): ${lists.join(' · ')}${way_up}`)
    }
  }
  for (const [key, label] of [['in_use', 'in-use set'], ['phone8', 'phone8+index8']]) {
    const backends = compare[key]
    if (!backends) continue
    const [backend, item] = Object.entries(backends)[0]
    parts.push(`${label}: top 1 ${item.top1_agree ? 'agrees' : 'differs'} · phone's top 1 in server's top 20: ${item.phone_top1_in_server_top20 ? 'yes' : 'no'} · ${item.overlap}/20 shared (${backend})`)
  }
  return parts.join(' | ')
}

/** "full matcher: phone <card or unsure> / server <card or unsure> · agree yes/no · N/20" for a run that holds the phone's full-matcher answer (step 3d). */
export function matcherAgreementText(run) {
  const matcher = run.matcher
  if (!matcher) return null
  const phone = matcher.picture_only ? 'picture only' : (matcher.decided ? matcher.card : 'unsure')
  const compare = run.matcher_compare
  if (!run.has_photo) return `full matcher: phone ${phone} · no photo, so no server answer`
  if (!compare || compare.status !== 'compared') return `full matcher: phone ${phone} · server answer ${run.server?.status === 'pending' || !run.server ? 'running…' : 'not available'}`
  const server = compare.server || 'unsure'
  const mechanism = compare.same_card && !compare.same_mechanism ? ` · mechanism differs (phone ${compare.phone_mechanism || '–'}, server ${compare.server_mechanism || '–'})` : ''
  return `full matcher: phone ${phone} / server ${server} · agree ${compare.agree ? 'yes' : 'no'} · ${compare.overlap}/20${mechanism}`
}

/** The stage times of a matcher run: "finder 600 · embed 800 · … total 2,100 ms (first 2,500)". */
export function matcherTimingText(run) {
  const timings = run.matcher?.timings
  if (!timings) return null
  const stages = [['finder', 'finder'], ['views', 'views'], ['embed', 'embed'], ['search', 'search'], ['ocr_number', 'number'], ['name', 'name'], ['second_read', 'second read'], ['decide', 'decide']]
  const parts = stages.filter(([key]) => timings[key]).map(([key, label]) => `${label} ${number(timings[key][1])}`)
  const total = timings.total
  const reader = run.matcher.ocr ? Object.entries(run.matcher.ocr).map(([stage, c]) => `${stage.replace('ocr_', '')} ${c.det_calls} det / ${c.rec_calls} rec`).join(', ') : null
  const ladder = run.matcher.ladder ? `ladder ${run.matcher.ladder.attempts} steps, stopped by ${run.matcher.ladder.stopped}` : null
  return `${run.matcher.backend || '?'} · ${parts.join(' · ')}${total ? ` · total ${number(total[1])} ms (first ${number(total[0])})` : ''}${reader ? ` · reader calls: ${reader}` : ''}${ladder ? ` · ${ladder}` : ''}${run.matcher.variant ? ` · ${run.matcher.variant}` : ''}`
}

/** The last phone speed-test runs (numbers, device facts, the photo thumbnail, agreement with the server) and the way to the test page. Admins only: the section is. */
export function PhoneSpeedRuns({ runs, onDelete }) {
  const when = value => String(value || '').slice(0, 16).replace('T', ' ')
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-phone-speed">
      <div className="flex items-center justify-between gap-3">
        <span className="text-footnote text-text-secondary">Phone speed test (step 2)</span>
        <Link to="/settings/phone-speed" className={button} data-testid="scanner-lab-phone-speed-link">
          <Smartphone size={13} aria-hidden="true" /> Phone speed test
        </Link>
      </div>
      {(runs || []).length === 0 && <p className="text-footnote text-text-secondary">No runs yet. Open it on the iPhone, in the Home Screen app, on Wi-Fi.</p>}
      {(runs || []).map(run => {
        const t = run.timings || {}
        const d = run.device || {}
        return (
          <div key={run.id || run.at + run.by} className="flex items-start gap-2" data-testid="scanner-lab-phone-speed-run">
            {run.has_photo && run.id && <RunThumb id={run.id} />}
            <p className="min-w-0 flex-1 text-footnote tabular-nums">
              {run.matcher
                ? <>{when(run.at)} · {describeIos(d)} · {d.gpu ? 'WebGPU' : 'no WebGPU'} · full phone matcher</>
                : <>{when(run.at)} · {describeIos(d)} · {d.gpu ? 'WebGPU' : 'no WebGPU'} · embed {number(t.embed_wasm_median_ms)} ms · card ×7 {number(t.card_wasm_median_ms)} ms
                  {' '}· est. {number(t.estimate_card_wasm_ms)} ms{t.estimate_card_webgpu_fp16_ms != null ? ` (GPU ${number(t.estimate_card_webgpu_fp16_ms)} ms)` : ''}</>}
              {d.crashedBefore && !run.crashed_step ? ' · crashed before' : ''}
              {run.crashed_step && <span className="block font-semibold text-red-500" data-testid="scanner-lab-phone-speed-crashed">Crashed during {run.crashed_step}</span>}
              {run.matcher && <span className="block" data-testid="scanner-lab-phone-matcher-agreement">{matcherAgreementText(run)}</span>}
              {run.matcher && <span className="block text-text-secondary" data-testid="scanner-lab-phone-matcher-timing">{matcherTimingText(run)}</span>}
              {!run.matcher && <span className="block text-text-secondary" data-testid="scanner-lab-phone-speed-agreement">{agreementText(run)}</span>}
            </p>
            {onDelete && run.id && (
              <button type="button" className="flex-shrink-0 text-footnote text-red-500 ios-press" onClick={() => { if (window.confirm('Delete this run and its photo from the server?')) onDelete(run.id) }} data-testid="scanner-lab-phone-speed-delete">Delete</button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function CompareTable({ report, title, phone }) {
  const [openWrong, setOpenWrong] = useState(null)
  const opened = report.rows.find(row => row.label === openWrong)
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid={`scanner-lab-${report.kind}`}>
      <div>
        <h3 className="text-subheadline font-semibold">{title}</h3>
        <p className="text-footnote text-text-secondary">
          {number(report.n)} photos · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)}
          {report.winner ? ` · kept: ${describeOptions(report.winner)}` : ''}
        </p>
      </div>
      {report.held_back_note && <p className="text-footnote text-text-secondary" data-testid="scanner-lab-held-back-note">{report.held_back_note}</p>}
      {report.groups && Object.keys(report.groups).some(name => name !== 'local') && (
        <p className="text-footnote text-text-secondary">
          {Object.entries(report.groups).map(([name, g]) => `${g.label || name}: ${number(g.scans)} scans, ${trainerCount(g.trainers)}`).join(' · ')}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-footnote">
          <thead>
            <tr className="text-left text-text-secondary">
              <th className="pr-2 font-normal">Options</th><th className="pr-2 font-normal">Top 1</th><th className="pr-2 font-normal">Top 20</th>
              <th className="pr-2 font-normal">Number</th><th className="pr-2 font-normal">Decided</th><th className="pr-2 font-normal">Wrong</th><th className="font-normal">p95</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map(row => (
              <tr key={row.label} className={`tabular-nums ${row.label === report.winner ? 'font-semibold' : ''}`}>
                <td className="pr-2">{describeOptions(row.label)}{isPhoneLabel(row.label) && <span className="ml-1 text-text-secondary" data-testid="scanner-lab-phone-row">(phone)</span>}</td>
                {row.status === 'ok' ? (
                  <>
                    <td className="pr-2">{percent(row.top1)}</td><td className="pr-2">{percent(row.top20)}</td><td className="pr-2">{percent(row.number_exact)}</td>
                    <td className="pr-2">{percent(row.decided)}</td>
                    <td className="pr-2">
                      {row.decided_wrong > 0 ? (
                        <button type="button" className="ios-press text-tint underline" aria-expanded={openWrong === row.label} onClick={() => setOpenWrong(openWrong === row.label ? null : row.label)} data-testid="scanner-lab-row-wrong-open">
                          {number(row.decided_wrong)}
                        </button>
                      ) : number(row.decided_wrong)}
                    </td>
                    <td>{row.p95_ms != null ? `${number(row.p95_ms)} ms` : '–'}</td>
                  </>
                ) : (
                  <td colSpan={6} className="text-text-secondary">{row.error ? `could not run here: ${row.error}` : `needs the ${(row.missing_indexes || []).join(', ')} index`}</td>
                )}
              </tr>
            ))}
            {report.held_back && report.held_back.status === 'ok' && (
              <tr className="tabular-nums text-text-secondary" data-testid="scanner-lab-held-back-row">
                <td className="pr-2">Held back, with {describeOptions(report.held_back.label)} ({number(report.held_back.n)} scans)</td>
                <td className="pr-2">{percent(report.held_back.top1)}</td><td className="pr-2">{percent(report.held_back.top20)}</td><td className="pr-2">{percent(report.held_back.number_exact)}</td>
                <td className="pr-2">{percent(report.held_back.decided)}</td><td className="pr-2">{number(report.held_back.decided_wrong)}</td><td>{report.held_back.p95_ms != null ? `${number(report.held_back.p95_ms)} ms` : '–'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {opened && <WrongList row={opened} />}
      <PhoneNote phone={phone} rows={report.rows} />
    </div>
  )
}

const OCR_MODE_NAMES = { fixed: 'Fixed strips (old way)', detect: 'Find and read (new way)', wholeread: 'Find and read, then the whole picture' }
const OCR_VARIANT_NAMES = { plain: 'as photographed', sharp: 'sharpened', clahe: 'local contrast', binary: 'black and white', deglare: 'glare removed' }
const RESOLUTION_NAMES = { 1024: 'Older scans: 1024 px crop', full: 'Newer scans: full resolution', guide_crop: 'Card not found: read from the guide frame', all: 'All scans' }

function OcrRows({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-footnote">
        <thead>
          <tr className="text-left text-text-secondary">
            <th className="pr-2 font-normal">Read</th><th className="pr-2 font-normal">Name</th><th className="pr-2 font-normal">Number</th>
            <th className="pr-2 font-normal">Total</th><th className="pr-2 font-normal">Set code</th><th className="font-normal">p95</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, row]) => (
            <tr key={key} className="tabular-nums">
              <td className="pr-2">{key.startsWith('variant:') ? `Band: ${OCR_VARIANT_NAMES[key.slice(8)] || key.slice(8)}` : OCR_MODE_NAMES[key] || key}</td>
              <td className="pr-2">{percent(row.name_pct)}</td><td className="pr-2">{percent(row.number_pct)}</td>
              <td className="pr-2">{percent(row.total_pct)}</td><td className="pr-2">{percent(row.set_code_pct)}</td>
              <td>{row.seconds_p95 != null ? `${number(Math.round(row.seconds_p95 * 1000))} ms` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const STEP_LABELS = {
  'whole-number-left-tight': 'Whole picture: left corner strip', 'whole-number-right-tight': 'Whole picture: right corner strip', 'whole-bottom-band': 'Whole picture: bottom band', 'number-left-tight': 'Number: left corner strip', 'number-right-tight': 'Number: right corner strip', 'bottom-band': 'Number: whole bottom band',
  'number-left-wide': 'Number: left wide strip', 'number-right-wide': 'Number: right wide strip', 'bottom-wide': 'Number: tall band at the bottom',
  'name-line': 'Name: top strip', 'name-band': 'Name: name band', 'top-wide': 'Name: tall band at the top',
}

function StepRows({ rows, kind, never, scans }) {
  return (
    <table className="w-full text-footnote">
      <thead>
        <tr className="text-left text-text-secondary">
          <th className="pr-2 font-normal">Step, in order</th><th className="pr-2 font-normal">Run on</th>
          <th className="pr-2 font-normal">First right {kind} here</th><th className="pr-2 font-normal">Time each</th><th className="font-normal">Time in all</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.step} className="tabular-nums">
            <td className="pr-2">{STEP_LABELS[row.label] || row.label} · {OCR_VARIANT_NAMES[row.variant] || row.variant}</td>
            <td className="pr-2">{row.run}</td><td className="pr-2">{row.first_right}</td>
            <td className="pr-2">{row.mean_ms != null ? `${number(Math.round(row.mean_ms))} ms` : '–'}</td><td>{duration(row.total_seconds)}</td>
          </tr>
        ))}
        <tr className="tabular-nums text-text-secondary">
          <td className="pr-2">Never right</td><td className="pr-2">{scans}</td><td className="pr-2">{never}</td><td /><td />
        </tr>
      </tbody>
    </table>
  )
}

/** What each reading step rescues: of the scans, how many first had the right number (name) at each step, and its time. */
export function OcrSteps({ steps }) {
  const groups = Object.entries(steps || {})
  if (groups.length === 0) return null
  return (
    <div className="space-y-2" data-testid="scanner-lab-ocr-steps">
      <h4 className="text-footnote font-semibold">What each reading step rescues</h4>
      <p className="text-footnote text-text-secondary">
        The steps run in this order and stop once the number is complete and sure. “First right” counts the scans whose right answer first appeared at that step, so a step with 0 there
        saved nothing that an earlier step had not already saved. This is what decides which steps can be dropped for good.
      </p>
      {groups.map(([resolution, group]) => (
        <div key={resolution} data-testid={`scanner-lab-ocr-steps-${resolution}`}>
          <h5 className="text-footnote font-semibold">{RESOLUTION_NAMES[resolution] || resolution} ({number(group.scans)} scans)</h5>
          <StepRows rows={group.number} kind="number" never={group.never_number} scans={group.scans} />
          <StepRows rows={group.name} kind="name" never={group.never_name} scans={group.scans} />
        </div>
      ))}
    </div>
  )
}

const sayNumber = value => (value == null ? '–' : value)

/** Version 9: how sharp, bright and glared the flat cards were, where the number was read and where it was not, so "photographed worse" can be told from "printed differently". */
export function CaptureQuality({ data }) {
  if (!data || !data.scans) return null
  const t = data.thresholds || { brightness: 85, sharpness: 30 }
  const line = block => `typical sharpness ${sayNumber(block.read.sharpness)} where the number was read (${number(block.read.n)} scans), ${sayNumber(block.missed.sharpness)} where it was not (${number(block.missed.n)}); typical brightness ${sayNumber(block.read.brightness)} against ${sayNumber(block.missed.brightness)} (out of 255); blown-out share ${sayNumber(block.read.blown_pct)}% against ${sayNumber(block.missed.blown_pct)}%`
  return (
    <div className="space-y-1" data-testid="scanner-lab-capture">
      <h5 className="text-footnote font-semibold">How well the scans were photographed</h5>
      <p className="text-[11px] text-text-secondary">All scans: {line(data)}.</p>
      {data.missed.n > 0 && (
        <p className="text-[11px] text-text-secondary">
          {sayNumber(data.missed_low_light_or_blur_pct)}% of the scans where the number was not read are low light or blur (brightness under {t.brightness} or sharpness under {t.sharpness}), against {sayNumber(data.read_low_light_or_blur_pct)}% of the scans where it was read.
        </p>
      )}
      {data.sets?.length > 0 && (
        <ul className="space-y-1 text-[11px] text-text-secondary">
          {data.sets.map(item => (
            <li key={item.set} className="break-words" data-testid="scanner-lab-capture-set">
              {item.set}: {line(item)}.{item.missed.n > 0 ? ` ${sayNumber(item.missed_low_light_or_blur_pct)}% of its ${number(item.missed.n)} misses are low light or blur.` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-text-secondary">
        If a set’s misses are much less sharp or darker than its reads, it was photographed worse. If they look the same as its reads, the number is missed for another reason, for example the set prints its number differently.
      </p>
    </div>
  )
}

/** Why the number was never right, per group: counts per cause and up to ten examples each, as text. */
export function NeverRight({ data, capture }) {
  const groups = Object.entries(data || {}).filter(([, group]) => group.scans)
  if (groups.length === 0) return null
  return (
    <div className="space-y-2" data-testid="scanner-lab-never-right">
      <h4 className="text-footnote font-semibold">Why the number was not read right</h4>
      <p className="text-footnote text-text-secondary">
        Per group of scans. “Never right” is split by what was read in the bottom area. The last cause counts scans whose number came out right but with another set total than the catalogue prints.
        The sets show whether the misses sit in a few new sets (a catalogue question) or are spread over all of them (a reading question).
      </p>
      {groups.map(([resolution, group]) => (
        <div key={resolution} className="space-y-1" data-testid={`scanner-lab-never-right-${resolution}`}>
          <h5 className="text-footnote font-semibold">{RESOLUTION_NAMES[resolution] || resolution} ({number(group.scans)} scans)</h5>
          {group.buckets.map(bucket => (
            <details key={bucket.key}>
              <summary className="cursor-pointer text-footnote">{bucket.label}: <span className="tabular-nums">{number(bucket.n)}</span></summary>
              <ul className="space-y-1 pt-1 text-[11px] text-text-secondary">
                {bucket.examples.map(item => (
                  <li key={item.trace} className="break-words">
                    {item.name} ({item.set}) · confirmed {item.truth.number}{item.truth.total ? `/${item.truth.total}` : ''} · read {item.read.number ? `${item.read.number}${item.read.total ? `/${item.read.total}` : ''}` : 'no number'}
                    {item.lines?.length ? ` · text: ${item.lines.join(' | ')}` : ' · no text'}
                  </li>
                ))}
                {bucket.examples.length === 0 && <li>None.</li>}
              </ul>
            </details>
          ))}
          {group.sets?.length > 0 && (
            <p className="text-[11px] text-text-secondary">Sets with the most wrong: {group.sets.map(item => `${item.set} ${item.wrong} of ${item.scans}`).join(' · ')}</p>
          )}
          <CaptureQuality data={capture?.[resolution]} />
        </div>
      ))}
    </div>
  )
}

/** Version 9: how many scans the whole-picture second read was tried on and how many it completed. */
export function WholeReadSummary({ data }) {
  const rows = Object.entries(data || {}).filter(([, counts]) => counts.tried > 0)
  if (rows.length === 0) return null
  return (
    <p className="text-footnote text-text-secondary" data-testid="scanner-lab-wholeread">
      Whole-picture second read (the “wholeread” row, and “whole-…” steps in the table below): {rows.map(([group, counts]) => `${RESOLUTION_NAMES[group] || group}: tried on ${counts.tried} scans, completed the number on ${counts.rescued}`).join(' · ')}.
    </p>
  )
}

/** The OCR check: the text reader alone on the confirmed real photos, split by the resolution it read from. */
export function OcrCheckView({ report }) {
  const groups = Object.entries(report.by_resolution || {})
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-ocr-check">
      <div>
        <h3 className="text-subheadline font-semibold">OCR check: real scans</h3>
        <p className="text-footnote text-text-secondary">
          {number(report.traces)} confirmed scans ({number(report.skipped)} skipped; not-found cards are read from the guide frame and shown as their own group) · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)}.
          What the reader got right against the confirmed card, before any lookup.
        </p>
      </div>
      {groups.map(([resolution, rows]) => {
        const entries = Object.entries(rows)
        return (
          <div key={resolution} data-testid={`scanner-lab-ocr-check-${resolution}`}>
            <h4 className="text-footnote font-semibold">{RESOLUTION_NAMES[resolution] || resolution} ({number(entries[0]?.[1]?.n)})</h4>
            <OcrRows rows={entries} />
          </div>
        )
      })}
      <NeverRight data={report.never_right} capture={report.capture} />
      <WholeReadSummary data={report.wholeread} />
      <OcrSteps steps={report.steps} />
      {Object.entries(report.groups || {}).map(([name, group]) => {
        const rows = Object.entries(group.by_resolution?.all || {})
        const info = report.group_info?.[name]
        return (
          <div key={name} data-testid={`scanner-lab-ocr-group-${name}`}>
            <h4 className="text-footnote font-semibold">
              {group.label || info?.label || name} ({number(info?.scans ?? group.scans)} scans, {trainerCount(info?.trainers ?? group.trainers)})
            </h4>
            {rows.length > 0 && <OcrRows rows={rows} />}
          </div>
        )
      })}
      {report.groups && Object.keys(report.groups).length > 0 && <p className="text-footnote text-text-secondary">{report.groups_note}</p>}
      {(report.failures || []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-footnote text-text-secondary">First {report.failures.length} scans where the name or the number was not read</summary>
          <ul className="space-y-1 pt-1 text-[11px] text-text-secondary">
            {report.failures.map(item => (
              <li key={item.trace} className="break-words">
                {item.truth.name} #{item.truth.number}{item.truth.total ? `/${item.truth.total}` : ''} ({item.resolution}, {item.height} px) · read name “{item.read.name || '–'}”, number {item.read.number ? `${item.read.number}${item.read.total ? `/${item.read.total}` : ''}` : '–'}
                {item.lines?.length ? ` · text: ${item.lines.join(' | ')}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const RIGHT_LABEL = { matcher: 'the matcher', ollama: 'Ollama', current: 'Ollama', neither: 'neither' }

function SideBySide({ data }) {
  const view = data.recorded || data.rerun
  return (
    <div data-testid="scanner-lab-side-by-side">
      <h4 className="text-footnote font-semibold">Matcher and Ollama side by side ({number(view.n)} confirmed photos, Ollama ran on {number(view.current?.n ?? view.n)}{data.recorded ? ', matcher as recorded at scan time' : ', matcher run again now'})</h4>
      <Row label="Matcher decided / right" value={`${percent(view.matcher.decided_pct)} / ${percent(view.matcher.right_pct)}`} />
      <Row label="Ollama decided / right" value={`${percent(view.current.decided_pct)} / ${percent(view.current.right_pct)}`} />
      <Row label="Both decided, but differently" value={`${number(view.differ)} of ${number(view.both_decided)}`} />
      <Row label="Of those, right: matcher / Ollama / neither" value={`${number(view.differ_matcher_right)} / ${number(view.differ_current_right)} / ${number(view.differ_neither_right)}`} />
      {(data.disagreements || []).length > 0 && (
        <ul className="mt-1 space-y-0.5 text-footnote text-text-secondary">
          {data.disagreements.map((item, position) => (
            <li key={position}>Matcher: {item.matcher} · Ollama: {item.ollama} · confirmed: {item.confirmed} (right: {RIGHT_LABEL[item.right] || item.right})</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PictureFirstView({ data, onOpenDecidedWrong }) {
  const counts = data.counts
  return (
    <div className="space-y-1 border-t border-separator px-4 py-3" data-testid="scanner-lab-picture-first">
      <div>
        <h3 className="text-subheadline font-semibold">Picture match first</h3>
        <p className="text-footnote text-text-secondary">
          {data.enabled ? 'On.' : 'Off.'} Last {counts.days} days, from the scans themselves.
        </p>
      </div>
      <Row testId="scanner-lab-pf-decided" label="Decided by picture" value={number(counts.decided)} />
      <Row testId="scanner-lab-pf-ollama" label="Sent to Ollama" value={number(counts.ollama)} />
      <Row testId="scanner-lab-pf-inbox" label="Sent to the inbox while the scanner was unreachable" value={number(counts.inbox)} />
      <Row
        testId="scanner-lab-pf-different"
        label="Trainer picked a different card than the picture decided"
        value={
          onOpenDecidedWrong ? (
            <button type="button" className="ios-press text-tint underline" onClick={onOpenDecidedWrong} data-testid="scanner-lab-pf-different-open">
              {`${number(counts.picked_different)} of ${number(counts.decided_confirmed)} confirmed${counts.error_pct != null ? ` (${counts.error_pct}%)` : ''}`}
            </button>
          ) : (
            `${number(counts.picked_different)} of ${number(counts.decided_confirmed)} confirmed${counts.error_pct != null ? ` (${counts.error_pct}%)` : ''}`
          )
        }
      />
      {onOpenDecidedWrong && (
        <p className="text-footnote text-text-secondary">Tap the figure to see the scans the matcher decided wrong when it was run again on the confirmed photos (Misses › Decided wrong).</p>
      )}
    </div>
  )
}

const CONFIRMED_LABELS = [
  ['scanner_decision', 'The scanner’s own pick, accepted'],
  ['matcher_candidate', 'Picked from the matcher’s candidates'],
  ['ollama_candidate', 'Picked from Ollama’s candidates'],
  ['manual_search', 'Found by search (no scanner offered it)'],
  ['manual_no_result', 'Found by search (scan had no result)'],
]

/** How the trainers’ confirmed cards were chosen; the two search rows are misses for every path. */
export function HowConfirmedView({ data }) {
  if (!data || !data.total) return null
  return (
    <div className="space-y-1 border-t border-separator px-4 py-3" data-testid="scanner-lab-how-confirmed">
      <h4 className="text-footnote font-semibold">How the {number(data.total)} confirmed cards were chosen</h4>
      {CONFIRMED_LABELS.map(([key, label]) => (
        <Row key={key} testId={`scanner-lab-how-${key}`} label={label} value={number(data.counts?.[key])} />
      ))}
      <p className="text-footnote text-text-secondary">
        {number(data.manual)} ({percent(data.manual_pct)}) needed the search box. Those count as misses for the matcher and for Ollama, and the cards are kept as answers for the benchmarks.
      </p>
    </div>
  )
}

const CAMERA_VERDICTS = {
  none: 'No scans with a camera frame size yet. Scan a card on the phone to find out.',
  hd: 'The phone sends frames of about 1080p (1920 px). The sharper crop cannot add detail, because the card is already as sharp as the camera gives. A higher-quality camera stream is needed instead.',
  sharp: 'The phone sends frames bigger than the 2048 px review photo, so the sharper crop keeps real detail the old photo threw away.',
}

/** What the phone camera really delivers, and how tall the card was that the text was read from. */
export function CameraView({ camera }) {
  if (!camera) return null
  const size = value => (value ? `${number(value)} px` : '–')
  const frame = camera.frame_common ? `${number(camera.frame_common[0])} × ${number(camera.frame_common[1])}` : '–'
  return (
    <div data-testid="scanner-lab-camera" className={`rounded-lg border px-3 py-2 ${camera.verdict === 'hd' ? 'border-amber-500/50 bg-amber-500/5' : 'border-separator'}`}>
      <h4 className="text-footnote font-semibold">Camera and reading detail</h4>
      <p className="text-footnote text-text-secondary" data-testid="scanner-lab-camera-verdict">{CAMERA_VERDICTS[camera.verdict] || CAMERA_VERDICTS.none}</p>
      <Row testId="scanner-lab-camera-frame" label={`Typical camera frame (${number(camera.new_scans)} new scans)`} value={`${frame} · long side ${size(camera.frame_long_side)}`} />
      <Row label="Typical sharper crop kept (long side)" value={size(camera.crop_long_side)} />
      <Row testId="scanner-lab-camera-height-new" label="Card height the text was read from: new scans" value={size(camera.card_height_new)} />
      <Row testId="scanner-lab-camera-height-older" label={`Card height the text was read from: older scans (${number(camera.older_scans)})`} value={size(camera.card_height_older)} />
    </div>
  )
}

export function ShadowView({ data }) {
  const report = data.report
  const confirmed = report.confirmed
  const skipped = Object.entries({ ...(report.skipped || {}), ...(data.worker?.skipped || {}) })
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-shadow">
      <div>
        <h3 className="text-subheadline font-semibold">Shadow run</h3>
        <p className="text-footnote text-text-secondary">
          The matcher looks at each new scan from trainers who share diagnostics and records what it would have decided. Nothing changes for trainers.
          {data.enabled ? '' : ' It is switched off on this server.'}
        </p>
      </div>
      <Row testId="scanner-lab-shadow-compared" label="Scans compared" value={number(report.compared)} />
      <Row label="Agree when both decided" value={`${percent(report.agreement.agree_pct)} (${number(report.agreement.same)} of ${number(report.agreement.both_decided)})`} />
      <Row label="Matcher would decide on its own" value={percent(report.matcher_decided_pct)} />
      <Row label="Median matcher time" value={report.median_ms != null ? `${number(report.median_ms)} ms` : '–'} />
      <CameraView camera={report.camera} />
      <div data-testid="scanner-lab-shadow-confirmed">
        <h4 className="text-footnote font-semibold">On the {number(confirmed.n)} scans you confirmed (English cards)</h4>
        <Row label="Matcher decided / of those, right" value={`${percent(confirmed.matcher.decided_pct)} / ${percent(confirmed.matcher.right_pct)}`} />
        <Row label="Ollama decided / of those, right" value={`${percent(confirmed.current.decided_pct)} / ${percent(confirmed.current.right_pct)}`} />
        <Row label="Different answers: matcher / Ollama / neither right" value={`${number(confirmed.differ_matcher_right)} / ${number(confirmed.differ_current_right)} / ${number(confirmed.differ_neither_right)}`} />
      </div>
      {skipped.length > 0 && (
        <p className="text-footnote text-text-secondary">Skipped: {skipped.map(([reason, count]) => `${reason.replace(/_/g, ' ')} (${count})`).join(', ')}</p>
      )}
      {report.disagreements.length > 0 && (
        <div data-testid="scanner-lab-shadow-disagreements">
          <h4 className="text-footnote font-semibold">Latest disagreements</h4>
          <ul className="space-y-0.5 text-footnote text-text-secondary">
            {report.disagreements.map((item, position) => (
              <li key={position}>
                Matcher: {item.matcher} · Ollama: {item.current}{item.confirmed ? ` · confirmed: ${item.confirmed} (right: ${RIGHT_LABEL[item.right] || item.right})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Settings › Data & sync, admins only: the picture matcher prototype (docs/CARD_MATCH.md). Index
 * coverage, build and benchmark buttons, and the latest benchmark report against the Phase 1 pass bar.
 * Nothing here changes how scans are recognised or what trainers see.
 */
export default function ScannerLabSection() {
  const queryClient = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/card-match/status').then(response => response.data),
    refetchInterval: query => (query.state.data?.job?.running ? 3000 : false),
    retry: false,
  })
  const shadow = useQuery({
    queryKey: SHADOW_KEY,
    queryFn: () => api.get('/card-match/shadow').then(response => response.data),
    refetchInterval: 30000,
    retry: false,
  })
  const pictureFirst = useQuery({
    queryKey: ['card-match-picture-first'],
    queryFn: () => api.get('/card-match/picture-first').then(response => response.data),
    refetchInterval: 60000,
    retry: false,
  })
  const speed = useQuery({
    queryKey: SPEED_KEY,
    queryFn: () => api.get('/card-match/phone-speed').then(response => response.data.runs),
    refetchInterval: query => ((query.state.data || []).some(run => run.server?.status === 'pending') ? 10000 : false),
    retry: false,
  })
  const deleteRun = useMutation({ mutationFn: id => api.delete(`/card-match/phone-speed/${id}`), onSuccess: () => queryClient.invalidateQueries({ queryKey: SPEED_KEY }) })
  const [missTag, setMissTag] = useState(null)
  const openDecidedWrong = () => {
    setMissTag('decided_wrong')
    setTimeout(() => document.querySelector('[data-testid="scanner-lab-misses"]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0)
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  const buildIndex = useMutation({ mutationFn: () => api.post('/card-match/index').then(r => r.data), onSuccess: refresh })
  const benchmark = useMutation({ mutationFn: kind => api.post('/card-match/benchmark', { kind }).then(r => r.data), onSuccess: refresh })
  const buildExtra = useMutation({ mutationFn: name => api.post('/card-match/index', { name }).then(r => r.data), onSuccess: refresh })
  const buildBundle = useMutation({ mutationFn: () => api.post('/card-match/phone-bundle/build').then(r => r.data), onSuccess: refresh })
  const stop = useMutation({ mutationFn: () => api.post('/card-match/stop').then(r => r.data), onSuccess: refresh })

  if (isError || !data) return null
  const job = data.job || {}
  const index = data.index || {}
  const running = Boolean(job.running)
  const ready = data.model?.available
  const progress = job.progress || {}
  const errorText = buildIndex.error?.response?.data?.detail || benchmark.error?.response?.data?.detail || buildExtra.error?.response?.data?.detail || buildBundle.error?.response?.data?.detail
  const busy = running || buildIndex.isPending || benchmark.isPending || buildExtra.isPending || buildBundle.isPending
  const extras = Object.entries(data.extra_indexes || {})

  let jobLine = null
  if (running) {
    const done = progress.indexed ?? progress.done
    const total = progress.todo ? progress.total : progress.total
    jobLine = `Running: ${job.kind}${done != null && total ? ` · ${number(done)} of ${number(total)}` : ''}`
  } else if (data.phone_error) {
    jobLine = `Phone steps failed: ${data.phone_error}${job.error && !data.phone_error.includes(job.error) ? ` · Last job failed: ${job.error}` : ''}`
  } else if (job.error) {
    jobLine = `Last job failed: ${job.error}`
  }

  return (
    <section className="space-y-1" data-testid="scanner-lab">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">Scanner lab</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <div className="space-y-2 px-4 py-3">
          <p className="text-footnote text-text-secondary">
            The picture matcher prototype. It only changes how scans are recognised while "Picture match first" is on in Settings › Scanner.
          </p>
          <Row testId="scanner-lab-coverage" label="English cards indexed" value={`${number(index.count)} of ${number(data.english_total)}`} />
          <Row label="Model" value={`${data.model?.name}${ready ? '' : ' (missing from this image)'}`} />
          <Row label="Index built" value={index.built ? `${index.built_at?.slice(0, 16).replace('T', ' ')} UTC · ${duration(index.build_seconds) || 'in steps'}` : 'not yet'} />
          <Row label="Threads" value={`${data.threads}${data.autorun ? ' · runs by itself after a deploy' : ''}`} />
          <Row testId="scanner-lab-options" label="Matching options in use" value={describeOptions(data.options?.active || 'baseline')} />
          <TraceSources sources={data.trace_sources} />
          {extras.map(([name, extra]) => (
            <Row key={name} label={`Index: ${extra.label}`} value={extra.built ? `${number(extra.count)} pictures` : 'not built'} />
          ))}
          {data.phone && (
            <Row testId="scanner-lab-phone-bundle" label="Phone bundle" value={data.phone.bundle?.built ? `built · ${megabytes(data.phone.bundle.total_bytes)} · ${number(data.phone.bundle.files)} files` : 'not built'} />
          )}
          {!data.ocr_available && <p className="text-footnote text-red-500">The OCR library is not installed in this image.</p>}
          {jobLine && <p className="text-footnote" aria-live="polite" data-testid="scanner-lab-job">{jobLine}</p>}
          {errorText && <p className="text-footnote text-red-500">{errorText}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={button} disabled={busy || !ready} onClick={() => buildIndex.mutate()} data-testid="scanner-lab-build">
              <Hammer size={13} aria-hidden="true" /> {index.built ? 'Update index' : 'Build index'}
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built} onClick={() => benchmark.mutate('synthetic')} data-testid="scanner-lab-synthetic">
              <FlaskConical size={13} aria-hidden="true" /> Run benchmark (synthetic)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built || !data.labelled_traces} onClick={() => benchmark.mutate('labelled')} data-testid="scanner-lab-labelled">
              <FlaskConical size={13} aria-hidden="true" /> Run on diagnostics ({number(data.labelled_traces)} scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !data.labelled_traces || !data.ocr_available} onClick={() => benchmark.mutate('ocr-check')} data-testid="scanner-lab-ocr-check-run">
              <FlaskConical size={13} aria-hidden="true" /> OCR check ({number(data.labelled_traces)} scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built || !data.labelled_traces} onClick={() => benchmark.mutate('compare-labelled')} data-testid="scanner-lab-compare">
              <GitCompare size={13} aria-hidden="true" /> Compare options (real scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built} onClick={() => benchmark.mutate('compare-synthetic')} data-testid="scanner-lab-compare-synthetic">
              <GitCompare size={13} aria-hidden="true" /> Compare options (synthetic)
            </button>
            {extras.map(([name, extra]) => (
              <button key={name} type="button" className={button} disabled={busy || !extra.available || !index.built} onClick={() => buildExtra.mutate(name)} data-testid={`scanner-lab-build-${name}`}>
                <Hammer size={13} aria-hidden="true" /> {extra.built ? 'Update' : 'Build'} {extra.label} index
              </button>
            ))}
            {data.phone && (
              <button type="button" className={button} disabled={busy || !data.phone.indexes || !Object.values(data.phone.indexes).every(item => item.built) || !data.phone.model?.available} onClick={() => buildBundle.mutate()} data-testid="scanner-lab-build-phone-bundle">
                <Hammer size={13} aria-hidden="true" /> {data.phone.bundle?.built ? 'Rebuild' : 'Build'} phone bundle
              </button>
            )}
            {running && (
              <button type="button" className={button} onClick={() => stop.mutate()}>Stop</button>
            )}
          </div>
        </div>
        <PhoneSpeedRuns runs={speed.data} onDelete={id => deleteRun.mutate(id)} />
        {pictureFirst.data?.counts && <PictureFirstView data={pictureFirst.data} onOpenDecidedWrong={data.misses ? openDecidedWrong : undefined} />}
        {shadow.data?.report && (shadow.data.enabled || shadow.data.report.compared > 0) && <ShadowView data={shadow.data} />}
        <HowConfirmedView data={shadow.data?.report?.how_confirmed} />
        {data.reports?.synthetic && <Report report={data.reports.synthetic} title="Latest benchmark: synthetic photos" />}
        {data.reports?.labelled && <Report report={data.reports.labelled} title="Latest benchmark: real scans (diagnostics)" />}
        {data.reports?.['ocr-check'] && <OcrCheckView report={data.reports['ocr-check']} />}
        {data.reports?.['compare-labelled'] && <CompareTable phone={data.phone} report={data.reports['compare-labelled']} title="Option comparison: real scans" />}
        {data.reports?.['compare-synthetic'] && <CompareTable phone={data.phone} report={data.reports['compare-synthetic']} title="Option comparison: synthetic photos" />}
        {data.misses && <Misses version={data.misses.created_at} tag={missTag} onTagChange={setMissTag} />}
        {!data.reports?.synthetic && !data.reports?.labelled && (
          <p className="border-t border-separator px-4 py-3 text-footnote text-text-secondary">No benchmark has run yet.</p>
        )}
      </div>
    </section>
  )
}
