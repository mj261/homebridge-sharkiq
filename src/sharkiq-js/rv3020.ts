import type { SharkIqVacuum } from './sharkiq.js'

import { encodeRoomListV3, Properties, readFlag } from './sharkiq.js'

/** Matter RVC operational states used by the RV3020's multifunction dock. */
export const RV3020_DOCK_OPERATIONAL_STATE = {
  emptyingDustBin: 67,
  cleaningMop: 68,
  fillingWaterTank: 69,
} as const

/** Additional Matter RVC errors the RV3020 base can report. */
const RV3020_MAINTENANCE_ERROR_STATE = {
  unableToCompleteOperation: 2,
  dustBinFull: 67,
  waterTankEmpty: 68,
  waterTankMissing: 69,
  mopCleaningPadMissing: 71,
  dirtyWaterTankFull: 74,
} as const

type JsonRecord = Record<string, any>

function parseRecord(raw: unknown): JsonRecord | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as JsonRecord
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  return undefined
}

function reportedFlag(vacuum: SharkIqVacuum, ...properties: string[]): boolean {
  return properties.some(property => readFlag(vacuum.get_property_value(property)) === true)
}

function nestedFlag(record: JsonRecord | undefined, ...path: string[]): boolean {
  let value: unknown = record
  for (const key of path) {
    if (!value || typeof value !== 'object') {
      return false
    }
    value = (value as JsonRecord)[key]
  }
  return readFlag(value) === true
}

/**
 * Translate the base's explicit activity flags to standard Matter dock states.
 *
 * `PadPriming` is deliberately excluded: hardware captures show it becoming
 * true while the robot is cleaning away from the base. The flags below belong
 * to the base operations themselves, so Home does not claim the dock is washing
 * or filling while the robot is actually in a room.
 */
export function rv3020DockOperationalState(
  vacuum: SharkIqVacuum,
): typeof RV3020_DOCK_OPERATIONAL_STATE[keyof typeof RV3020_DOCK_OPERATIONAL_STATE] | undefined {
  if (reportedFlag(vacuum, Properties.PAD_WASH, Properties.PAD_DRY, Properties.PUMP_GREY_WATER)) {
    return RV3020_DOCK_OPERATIONAL_STATE.cleaningMop
  }
  if (reportedFlag(vacuum, Properties.REFILLING, Properties.REFILL_RESUME, Properties.REFILL_RESUME_STATUS)) {
    return RV3020_DOCK_OPERATIONAL_STATE.fillingWaterTank
  }
  if (reportedFlag(vacuum, Properties.EVACUATING, 'evacuate')) {
    return RV3020_DOCK_OPERATIONAL_STATE.emptyingDustBin
  }
  return undefined
}

export interface RV3020MaintenanceError {
  errorStateId: number
  errorStateDetails: string
}

/**
 * Read maintenance conditions whose meaning is explicit in the RV3020 shadow.
 * Unknown dock/warning codes are still surfaced, but only as a generic error;
 * assigning a specific label to an undocumented numeric code would be worse
 * than keeping the exact number in the details.
 */
export function rv3020MaintenanceError(vacuum: SharkIqVacuum, running: boolean): RV3020MaintenanceError | undefined {
  const dock = parseRecord(vacuum.get_property_value(Properties.DOCK_SENSOR_DATA))
  if (nestedFlag(dock, 'GreyTank', 'Full')) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.dirtyWaterTankFull, errorStateDetails: 'Dirty water tank is full' }
  }
  if (nestedFlag(dock, 'CleanTank', 'Empty')) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.waterTankEmpty, errorStateDetails: 'Dock clean-water tank is empty' }
  }
  if (nestedFlag(dock, 'DustBin', 'Full') || nestedFlag(dock, 'DustBag', 'Full') || nestedFlag(dock, 'Bag', 'Full')) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.dustBinFull, errorStateDetails: 'Dust bin or base bag is full' }
  }

  // Missing robot-side mopping parts matter only for a pure mop job. The base
  // intentionally removes them during vacuum-only and the dry stage of a combo
  // job, so treating either flag as a permanent alert would be a false alarm.
  const mode = Number(vacuum.operating_mode())
  const desiredMode = Number(vacuum.get_property_value('_RV3020DesiredOperatingMode'))
  const pureMopJob = desiredMode === 7 || (desiredMode !== 8 && mode === 7)
  if (running && pureMopJob && readFlag(vacuum.get_property_value(Properties.WATER_TANK_INSTALLED)) === false) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.waterTankMissing, errorStateDetails: 'Robot water tank is missing' }
  }
  if (running && pureMopJob && readFlag(vacuum.get_property_value(Properties.MOP_PLATE_ATTACHED)) === false) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.mopCleaningPadMissing, errorStateDetails: 'Mop plate or cleaning pad is missing' }
  }

  const dockErrorCode = readNumber(vacuum.get_property_value(Properties.DOCK_ERROR_CODE))
  if (dockErrorCode !== undefined && dockErrorCode !== 0) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.unableToCompleteOperation, errorStateDetails: `Dock error (code ${dockErrorCode})` }
  }
  const warningCode = readNumber(vacuum.get_property_value(Properties.WARNING_CODE))
  if (warningCode !== undefined && warningCode !== 0) {
    return { errorStateId: RV3020_MAINTENANCE_ERROR_STATE.unableToCompleteOperation, errorStateDetails: `Vacuum warning (code ${warningCode})` }
  }
  return undefined
}

export interface RV3020LiveProgress {
  areaId: number | null
  percent?: number
}

/** Match Shark's live zone id to the 1-based Matter area id in Home's room list. */
export function rv3020LiveProgress(vacuum: SharkIqVacuum): RV3020LiveProgress {
  const live = parseRecord(vacuum.get_property_value(Properties.LIVE_PROGRESS))
  const floor = typeof live?.floor === 'string' ? live.floor : undefined
  let zone = typeof live?.zone === 'string' ? live.zone.trim() : ''

  // Some firmware publishes the current zone in LiveLocation rather than in
  // live_progress. Only accept a named zone/room; raw map coordinates cannot be
  // mapped honestly without retaining Shark's map geometry.
  if (!zone) {
    const locationRaw = vacuum.get_property_value(Properties.LIVE_LOCATION)
    const location = parseRecord(locationRaw)
    const candidate = location?.zone ?? location?.Zone ?? location?.room ?? location?.Room
    if (typeof candidate === 'string') {
      zone = candidate.trim()
    } else if (typeof locationRaw === 'string' && !locationRaw.trim().startsWith('{')) {
      zone = locationRaw.trim()
    }
  }

  const roomMap = vacuum.skegox?.getRoomMap(vacuum._dsn)
  const rooms = vacuum.get_room_list?.() ?? []
  let areaId: number | null = null
  if (zone && (!floor || !roomMap?.floorId || floor === roomMap.floorId)) {
    const displayName = roomMap?.nameMap[zone] ?? zone
    const index = rooms.findIndex(room => room === displayName || room === zone)
    areaId = index < 0 ? null : index + 1
  }

  const rawPercent = readNumber(live?.percent)
  const percent = rawPercent === undefined ? undefined : Math.max(0, Math.min(100, rawPercent))
  return { areaId, ...(percent === undefined ? {} : { percent }) }
}

/** Whole-house commands observed from SharkClean on RV3020XEUS hardware. */
const RV3020_CLEAN_METHODS = [
  { label: 'Vacuum', operatingMode: 6, modeTags: [{ value: 16385 }] },
  { label: 'Mop', operatingMode: 7, modeTags: [{ value: 16386 }] },
  { label: 'Vacuum + Mop', operatingMode: 8, modeTags: [{ value: 16385 }, { value: 16386 }] },
] as const

/**
 * Suction levels shown by SharkClean, with standard Matter mode tags.
 *
 * Apple Home derives its separate speed picker from these tags. Advertising
 * only Auto on the three cleaning methods therefore reduced that picker to a
 * single "Automatic" choice. Each method is published at every suction level
 * below so Home can keep both controls.
 */
const RV3020_POWER_LEVELS = [
  { label: 'Eco', powerMode: 1, modeOffset: 10, modeTag: 4 },
  { label: 'Normal', powerMode: 0, modeOffset: 0, modeTag: 0 },
  { label: 'Max', powerMode: 2, modeOffset: 20, modeTag: 7 },
] as const

const RV3020_MODE_COMBINATIONS = RV3020_CLEAN_METHODS.flatMap(method => RV3020_POWER_LEVELS.map(power => ({
  label: `${method.label} ${power.label}`,
  mode: method.operatingMode + power.modeOffset,
  modeTags: [...method.modeTags, { value: power.modeTag }],
  operatingMode: method.operatingMode,
  powerMode: power.powerMode,
})))

/** Matter clean modes: three cleaning methods × three suction levels. */
export const RV3020_CLEAN_MODES = RV3020_MODE_COMBINATIONS.map(({ label, mode, modeTags }) => ({ label, mode, modeTags }))

interface Selection {
  mode: number
  powerMode: number
  pendingUntil: number
}

const selections = new WeakMap<SharkIqVacuum, Selection>()

/** These command values are specific to this model, not all mop-capable Sharks. */
export function isRV3020(vacuum: SharkIqVacuum): boolean {
  return [vacuum._vac_model_number, vacuum.get_property_value('Device_Model_Number')]
    .some(model => String(model ?? '').trim().toUpperCase() === 'RV3020XEUS')
}

export function isRV3020Mode(mode: number): boolean {
  return RV3020_CLEAN_METHODS.some(entry => entry.operatingMode === mode)
}

/** Decode the single Matter mode id into Shark's two independent settings. */
export function rv3020ModeSelection(mode: number): { operatingMode: number, powerMode: number } | undefined {
  const selection = RV3020_MODE_COMBINATIONS.find(entry => entry.mode === mode)
  return selection ? { operatingMode: selection.operatingMode, powerMode: selection.powerMode } : undefined
}

function currentPowerMode(vacuum: SharkIqVacuum): number {
  const powerMode = Number(vacuum.power_mode())
  return RV3020_POWER_LEVELS.some(entry => entry.powerMode === powerMode) ? powerMode : 0
}

/** Preserve Home's selection while idle; reflect native app jobs while running. */
export function rv3020CleanMode(vacuum: SharkIqVacuum, observe = false): number {
  let selection = selections.get(vacuum) ?? { mode: 6, powerMode: currentPowerMode(vacuum), pendingUntil: 0 }
  if (observe && Date.now() >= selection.pendingUntil) {
    const reported = vacuum.operating_mode()
    if (isRV3020Mode(reported)) {
      const desired = vacuum.get_property_value('_RV3020DesiredOperatingMode')
      // A combined job may report 7 during its wet stage; retain job type 8.
      selection.mode = desired === 8 ? 8 : reported
    }
    selection = { ...selection, powerMode: currentPowerMode(vacuum), pendingUntil: 0 }
  }
  selections.set(vacuum, selection)
  return selection.mode
}

/** Current combined Matter method/suction mode. */
export function rv3020MatterCleanMode(vacuum: SharkIqVacuum, observe = false): number {
  const operatingMode = rv3020CleanMode(vacuum, observe)
  const powerMode = selections.get(vacuum)?.powerMode ?? currentPowerMode(vacuum)
  return RV3020_MODE_COMBINATIONS.find(entry => entry.operatingMode === operatingMode && entry.powerMode === powerMode)!.mode
}

export function selectRV3020Mode(vacuum: SharkIqVacuum, mode: number, powerMode = currentPowerMode(vacuum)): void {
  if (!isRV3020Mode(mode)) {
    throw new Error(`Unsupported RV3020 cleaning mode: ${mode}`)
  }
  if (!RV3020_POWER_LEVELS.some(entry => entry.powerMode === powerMode)) {
    throw new Error(`Unsupported RV3020 power mode: ${powerMode}`)
  }
  selections.set(vacuum, { mode, powerMode, pendingUntil: Date.now() + 15000 })
}

export interface RV3020MatterState {
  runMode: 0 | 1
  operationalState: 0 | 1 | 2 | 64 | 65 | 66 | 67 | 68 | 69
}

/**
 * Translate the RV3020's newer status fields into Matter RVC state.
 *
 * Captures from this hardware show robot_status 6 while cleaning, 7 while
 * seeking the dock, 13 once docked, and 32 during the start transition. These
 * values are live while DockedStatus can still contain the previous state.
 */
export function rv3020MatterState(vacuum: SharkIqVacuum, invertDockedStatus = false): RV3020MatterState {
  const mode = Number(vacuum.operating_mode())
  const robotStatus = Number(vacuum.get_property_value('robot_status'))
  const desiredMode = Number(vacuum.get_property_value('_RV3020DesiredOperatingMode'))
  const charging = vacuum.battery().charging === true
  const rawDocked = Number(vacuum.docked_status())
  const docked = invertDockedStatus ? rawDocked !== 1 : rawDocked === 1

  // Active and return states take precedence over DockedStatus because that
  // property lags behind the robot_status transition on this model.
  if (robotStatus === 6 || isRV3020Mode(mode)) {
    return { runMode: 1, operationalState: 1 }
  }
  if (robotStatus === 7) {
    return { runMode: 0, operationalState: 64 }
  }
  if (robotStatus === 32 && isRV3020Mode(desiredMode)) {
    return { runMode: 1, operationalState: 1 }
  }
  const dockOperation = rv3020DockOperationalState(vacuum)
  if (dockOperation !== undefined && (robotStatus === 13 || docked || charging)) {
    return { runMode: 0, operationalState: dockOperation }
  }
  if (robotStatus === 13) {
    return { runMode: 0, operationalState: charging ? 65 : 66 }
  }
  if (charging) {
    return { runMode: 0, operationalState: 65 }
  }
  if (mode === 0) {
    return { runMode: 1, operationalState: 2 }
  }
  if (mode === 3 && !docked && !charging) {
    return { runMode: 0, operationalState: 64 }
  }
  if (docked) {
    return { runMode: 0, operationalState: 66 }
  }
  return { runMode: 0, operationalState: 0 }
}

/** Send an explicit cleaning method and propagate cloud failures to Matter. */
export async function startRV3020(vacuum: SharkIqVacuum, rooms: string[]): Promise<void> {
  if (!vacuum.skegox?.available(vacuum._dsn)) {
    throw new Error('RV3020 cleaning requires the SharkNinja API. Sign in through the OAuth Assistant.')
  }
  const mode = rv3020CleanMode(vacuum)
  const label = RV3020_CLEAN_METHODS.find(entry => entry.operatingMode === mode)!.label
  if (rooms.length) {
    const target = vacuum.get_room_clean_target(rooms)
    if (!target.identifier) {
      throw new Error('RV3020 room cleaning requires a current Shark map floor id.')
    }
    const payload = encodeRoomListV3(target.rooms, target.identifier, {
      mode: 'UserRoom',
      cleanCount: 1,
      cleanType: mode === 6 ? 'dry' : 'wet',
    })
    vacuum.log.info(`RV3020: starting ${label} in ${rooms.join(', ')}.`)
    await vacuum.skegox.setProperty(vacuum._dsn, 'AreasToClean_V3', payload)
  } else {
    vacuum.log.info(`RV3020: starting ${label} (Operating_Mode=${mode}).`)
  }
  // The legacy set_property_value path swallows some failures. Use the API
  // directly so a failed write cannot be acknowledged as a successful start.
  await vacuum.skegox.setProperty(vacuum._dsn, 'Operating_Mode', mode)
  selectRV3020Mode(vacuum, mode, selections.get(vacuum)?.powerMode ?? currentPowerMode(vacuum))
}
