/**
 * The control row. Exactly the buttons that mean something right now — a permanently visible
 * set with three of them greyed out makes the user read the row every time instead of just
 * hitting the one live control.
 *
 * Two rules that are easy to get wrong:
 *  - while armed there is nothing to skip (`skip()` is a deliberate no-op in main, because
 *    advancing past an unstarted focus would bank a round nobody worked), so the pair is
 *    Start / Dismiss.
 *  - in Flowmodoro focus, "Take a break" and "Skip" perform the same transition. Showing both
 *    is two buttons for one action, so Skip stands down and the break button takes over —
 *    including as the primary while running, since cashing in the earned break is the whole
 *    point of the mode.
 */

import {
  accentColor,
  canTakeBreak,
  isArmed,
  isFresh,
  isPaused,
  isRunning,
  phaseName,
  timerActions,
  useTimerStore,
  ACCENT_BREAK
} from '../../stores/timer'
import { Button } from './Button'
import { CoffeeIcon, PauseIcon, PlayIcon, SkipIcon, StopIcon, XIcon } from './icons'

/** On the green primary the glyph inherits the button's dark ink; on a neutral secondary it
 *  carries the break colour itself, so the action still reads as "break" at a glance. */
const COFFEE = <CoffeeIcon className="h-4 w-4" />
const COFFEE_TINTED = <CoffeeIcon className="h-4 w-4 text-[var(--color-break)]" />

export function Controls(): React.JSX.Element {
  // Selecting derived booleans instead of the whole state keeps this row out of the
  // four-times-a-second render path — none of these change on a tick.
  const ready = useTimerStore((s) => s.ready)
  const running = useTimerStore((s) => isRunning(s.state))
  const paused = useTimerStore((s) => isPaused(s.state))
  const armed = useTimerStore((s) => isArmed(s.state))
  const fresh = useTimerStore((s) => isFresh(s.state))
  const breakAvailable = useTimerStore((s) => canTakeBreak(s.state))
  const accent = useTimerStore((s) => accentColor(s.state))
  const nextName = useTimerStore((s) => phaseName(s.state).toLowerCase())

  if (fresh || armed) {
    return (
      <div className="flex items-center justify-center gap-2">
        <Button
          size="lg"
          variant="primary"
          accent={accent}
          icon={<PlayIcon />}
          disabled={!ready}
          onClick={() => timerActions.start()}
        >
          {armed ? `Start ${nextName}` : 'Start focus'}
        </Button>

        {armed && (
          <Button
            variant="ghost"
            icon={<XIcon className="h-3.5 w-3.5" />}
            disabled={!ready}
            title="Clear the queued phase and return to idle"
            onClick={() => timerActions.stop()}
          >
            Dismiss
          </Button>
        )}
      </div>
    )
  }

  const takeBreakIsPrimary = running && breakAvailable

  return (
    <div className="flex items-center justify-center gap-2">
      {takeBreakIsPrimary ? (
        <Button
          size="lg"
          variant="primary"
          accent={ACCENT_BREAK}
          icon={COFFEE}
          disabled={!ready}
          onClick={() => timerActions.takeBreak()}
        >
          Take a break
        </Button>
      ) : (
        <Button
          size="lg"
          variant="primary"
          accent={accent}
          icon={running ? <PauseIcon /> : <PlayIcon />}
          disabled={!ready}
          onClick={() => (running ? timerActions.pause() : timerActions.resume())}
        >
          {running ? 'Pause' : 'Resume'}
        </Button>
      )}

      {takeBreakIsPrimary && (
        <Button
          variant="secondary"
          icon={<PauseIcon />}
          disabled={!ready}
          onClick={() => timerActions.pause()}
        >
          Pause
        </Button>
      )}

      {paused && breakAvailable && (
        <Button
          variant="secondary"
          icon={COFFEE_TINTED}
          disabled={!ready}
          onClick={() => timerActions.takeBreak()}
        >
          Take a break
        </Button>
      )}

      {!breakAvailable && (
        <Button
          variant="secondary"
          icon={<SkipIcon />}
          disabled={!ready}
          title="End this phase and start the next one"
          onClick={() => timerActions.skip()}
        >
          Skip
        </Button>
      )}

      <Button
        variant="danger"
        icon={<StopIcon className="h-3.5 w-3.5" />}
        disabled={!ready}
        title="End the session and log the time so far"
        onClick={() => timerActions.stop()}
      >
        Stop
      </Button>
    </div>
  )
}
