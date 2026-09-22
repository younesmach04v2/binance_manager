import { OpenPositions, PositionHistory } from '../components/Positions'

/** Every open position in one place: app-managed R positions and plain holdings with their exchange orders. */
export default function Positions() {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold">Positions</h1>
        <p className="text-sm text-muted">
          Everything you hold with the stop and target protecting it, whether the app manages it or you placed the orders yourself. "Manage with
          ladder" hands a position over to the break-even ladder.
        </p>
      </header>
      <OpenPositions />
      <PositionHistory />
    </div>
  )
}
