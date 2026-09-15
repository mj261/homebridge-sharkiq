import type { SharkIqVacuum } from './sharkiq.js'

/** Whole-house commands observed from SharkClean on RV3020XEUS hardware. */
export const RV3020_CLEAN_MODES = [
  { label: 'Vacuum', mode: 6, modeTags: [{ value: 16385 }, { value: 0 }] },
  { label: 'Mop', mode: 7, modeTags: [{ value: 16386 }, { value: 0 }] },
  { label: 'Vacuum + Mop', mode: 8, modeTags: [{ value: 16385 }, { value: 16386 }, { value: 0 }] },
] as const

interface Selection {
  mode: number
  pendingUntil: number
}

const selections = new WeakMap<SharkIqVacuum, Selection>()

/** These command values are specific to this model, not all mop-capable Sharks. */
export function isRV3020(vacuum: SharkIqVacuum): boolean {
  return [vacuum._vac_model_number, vacuum.get_property_value('Device_Model_Number')]
    .some(model => String(model ?? '').trim().toUpperCase() === 'RV3020XEUS')
}

export function isRV3020Mode(mode: number): boolean {
  return RV3020_CLEAN_MODES.some(entry => entry.mode === mode)
}

/** Preserve Home's selection while idle; reflect native app jobs while running. */
export function rv3020CleanMode(vacuum: SharkIqVacuum, observe = false): number {
  let selection = selections.get(vacuum) ?? { mode: 6, pendingUntil: 0 }
  if (observe && Date.now() >= selection.pendingUntil) {
    const reported = vacuum.operating_mode()
    if (isRV3020Mode(reported)) {
      const desired = vacuum.get_property_value('_RV3020DesiredOperatingMode')
      // A combined job may report 7 during its wet stage; retain job type 8.
      selection = { mode: desired === 8 ? 8 : reported, pendingUntil: 0 }
      selections.set(vacuum, selection)
    }
  }
  return selection.mode
}

export function selectRV3020Mode(vacuum: SharkIqVacuum, mode: number): void {
  if (!isRV3020Mode(mode)) {
    throw new Error(`Unsupported RV3020 cleaning mode: ${mode}`)
  }
  selections.set(vacuum, { mode, pendingUntil: Date.now() + 15000 })
}

/** Send an explicit cleaning method and propagate cloud failures to Matter. */
export async function startRV3020(vacuum: SharkIqVacuum, rooms: string[]): Promise<void> {
  if (rooms.length) {
    throw new Error('RV3020 room cleaning is not yet verified. Clear the room selection for a whole-house clean.')
  }
  if (!vacuum.skegox?.available(vacuum._dsn)) {
    throw new Error('RV3020 cleaning requires the SharkNinja API. Sign in through the OAuth Assistant.')
  }
  const mode = rv3020CleanMode(vacuum)
  const label = RV3020_CLEAN_MODES.find(entry => entry.mode === mode)!.label
  vacuum.log.info(`RV3020: starting ${label} (Operating_Mode=${mode}).`)
  // The legacy set_property_value path swallows some failures. Use the API
  // directly so a failed write cannot be acknowledged as a successful start.
  await vacuum.skegox.setProperty(vacuum._dsn, 'Operating_Mode', mode)
  selections.set(vacuum, { mode, pendingUntil: Date.now() + 15000 })
}
