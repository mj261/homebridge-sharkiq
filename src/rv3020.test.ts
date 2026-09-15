import { RvcCleanMode } from '@matter/types/clusters/rvc-clean-mode'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isRV3020, RV3020_CLEAN_MODES, rv3020CleanMode, rv3020MatterCleanMode, rv3020MatterState, rv3020ModeSelection, selectRV3020Mode, startRV3020 } from './sharkiq-js/rv3020.js'
import { selectCleaningDiagnostics, SkegoxApi } from './sharkiq-js/skegox_api.js'
import { SharkIQMatterPlatform } from './SharkIQMatterPlatform.js'

vi.mock('./platform.js', () => ({ SharkIQPlatform: class {} }))

function robot(model = 'RV3020XEUS') {
  const values: Record<string, any> = { Device_Model_Number: model, Operating_Mode: 3, Power_Mode: 0 }
  const vacuum: any = {
    _dsn: 'TEST',
    _name: 'Test robot',
    values,
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    get_property_value: (key: string) => values[key],
    operating_mode: () => values.Operating_Mode,
    is_paused: () => values.Operating_Mode === 0,
    get_room_list: () => ['Kitchen'],
    get_room_clean_target: (rooms: string[]) => ({ identifier: 'FLOOR1', rooms: rooms.map(room => room === 'Kitchen' ? 'AZ_8' : room) }),
    skegox: { available: () => true, setProperty: vi.fn().mockResolvedValue(undefined) },
    set_property_value: vi.fn().mockResolvedValue(undefined),
    clean_rooms: vi.fn().mockResolvedValue(undefined),
    cancel_clean: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    docked_status: () => values.DockedStatus ?? 0,
    power_mode: () => values.Power_Mode,
    fault: () => undefined,
    water_tank: () => ({ installed: false }),
    battery: () => ({ percent: 100, charging: values.Charging_Status === 1 }),
    mop_plate_attached: () => false,
  }
  return vacuum
}

function platform() {
  const p = Object.create(SharkIQMatterPlatform.prototype)
  Object.assign(p, {
    log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    config: {},
    matterRefreshers: new Map(),
    matterPollTimers: new Map(),
    matterAccessories: new Map(),
  })
  return p
}

afterEach(() => vi.useRealTimers())

describe('rV3020 Matter integration', () => {
  it('recognizes the exact model and advertises every method at all three speeds', () => {
    expect(isRV3020(robot())).toBe(true)
    expect(isRV3020(robot('RV2820'))).toBe(false)
    expect(RV3020_CLEAN_MODES).toHaveLength(9)
    expect(RV3020_CLEAN_MODES.filter(mode => mode.modeTags.some(tag => tag.value === RvcCleanMode.ModeTag.Vacuum))).toHaveLength(6)
    expect(RV3020_CLEAN_MODES.filter(mode => mode.modeTags.some(tag => tag.value === RvcCleanMode.ModeTag.Mop))).toHaveLength(6)
    for (const operatingMode of [6, 7, 8]) {
      const modes = [operatingMode + 10, operatingMode, operatingMode + 20]
        .map(mode => RV3020_CLEAN_MODES.find(entry => entry.mode === mode)!)
      expect(modes.map(mode => mode.modeTags.at(-1)?.value))
        .toEqual([RvcCleanMode.ModeTag.LowEnergy, RvcCleanMode.ModeTag.Auto, RvcCleanMode.ModeTag.Max])
    }
    expect(rv3020ModeSelection(6)).toEqual({ operatingMode: 6, powerMode: 0 })
    expect(rv3020ModeSelection(16)).toEqual({ operatingMode: 6, powerMode: 1 })
    expect(rv3020ModeSelection(26)).toEqual({ operatingMode: 6, powerMode: 2 })
  })

  it.each([6, 7, 8])('selects method %i without starting and sends it on start/resume', async (mode) => {
    const vacuum = robot()
    const handlers = platform()._buildMatterHandlers({}, 'test', vacuum)
    await handlers.rvcCleanMode.changeToMode({ newMode: mode })
    expect(vacuum.skegox.setProperty).toHaveBeenCalledWith('TEST', 'Power_Mode', 0)
    expect(vacuum.skegox.setProperty).not.toHaveBeenCalledWith('TEST', 'Operating_Mode', expect.anything())
    expect(vacuum.set_property_value).not.toHaveBeenCalled()
    expect(rv3020CleanMode(vacuum, true)).toBe(mode)
    await handlers.rvcRunMode.changeToMode({ newMode: 1 })
    await handlers.rvcOperationalState.resume()
    expect(vacuum.skegox.setProperty).toHaveBeenLastCalledWith('TEST', 'Operating_Mode', mode)
    expect(vacuum.skegox.setProperty.mock.calls.filter(([, property]) => property === 'Operating_Mode')).toHaveLength(2)
  })

  it('keeps the cleaning method while changing speed and sends both settings on the next job', async () => {
    const vacuum = robot()
    const handlers = platform()._buildMatterHandlers({}, 'test', vacuum)
    await handlers.rvcCleanMode.changeToMode({ newMode: 27 })
    expect(vacuum.skegox.setProperty).toHaveBeenCalledWith('TEST', 'Power_Mode', 2)
    expect(rv3020CleanMode(vacuum)).toBe(7)
    expect(rv3020MatterCleanMode(vacuum)).toBe(27)
    await handlers.rvcRunMode.changeToMode({ newMode: 1 })
    expect(vacuum.skegox.setProperty).toHaveBeenLastCalledWith('TEST', 'Operating_Mode', 7)

    vacuum.values.Operating_Mode = 7
    await handlers.rvcCleanMode.changeToMode({ newMode: 17 })
    expect(vacuum.skegox.setProperty).toHaveBeenLastCalledWith('TEST', 'Power_Mode', 1)
    await expect(handlers.rvcCleanMode.changeToMode({ newMode: 16 })).rejects.toThrow('Dock')
  })

  it('defaults to explicit dry cleaning and preserves idle selections', async () => {
    const vacuum = robot()
    await startRV3020(vacuum, [])
    expect(vacuum.skegox.setProperty).toHaveBeenCalledWith('TEST', 'Operating_Mode', 6)
    selectRV3020Mode(vacuum, 8)
    expect(rv3020CleanMode(vacuum, true)).toBe(8)
  })

  it('reflects native jobs after the settling interval, retaining a combined wet stage', () => {
    vi.useFakeTimers()
    const vacuum = robot()
    selectRV3020Mode(vacuum, 6)
    vacuum.values.Operating_Mode = 7
    expect(rv3020CleanMode(vacuum, true)).toBe(6)
    vi.advanceTimersByTime(16000)
    expect(rv3020CleanMode(vacuum, true)).toBe(7)
    vacuum.values._RV3020DesiredOperatingMode = 8
    expect(rv3020CleanMode(vacuum, true)).toBe(8)
    vacuum.values._RV3020DesiredOperatingMode = 7
    expect(rv3020CleanMode(vacuum, true)).toBe(7)
  })

  it('rejects unsupported selections and active mode changes, starts room jobs, and propagates API failures', async () => {
    const vacuum = robot()
    const h = platform()._buildMatterHandlers({}, 'test', vacuum)
    await expect(h.rvcCleanMode.changeToMode({ newMode: 2 })).rejects.toThrow('Unsupported')
    vacuum.values.Operating_Mode = 7
    await expect(h.rvcCleanMode.changeToMode({ newMode: 6 })).rejects.toThrow('Dock')
    vacuum.values.Operating_Mode = 3
    selectRV3020Mode(vacuum, 6)
    await h.serviceArea.selectAreas({ newAreas: [1] })
    await h.rvcRunMode.changeToMode({ newMode: 1 })
    expect(vacuum.skegox.setProperty).toHaveBeenNthCalledWith(1, 'TEST', 'AreasToClean_V3', '{"areas_to_clean":{"UserRoom":["AZ_8"]},"clean_count":1,"floor_id":"FLOOR1","cleantype":"dry"}')
    expect(vacuum.skegox.setProperty).toHaveBeenNthCalledWith(2, 'TEST', 'Operating_Mode', 6)
    vacuum.skegox.setProperty.mockClear()
    vacuum.skegox.setProperty.mockRejectedValue(new Error('Cloud unavailable'))
    await expect(h.rvcRunMode.changeToMode({ newMode: 1 })).rejects.toThrow('Cloud unavailable')
  })

  it('uses live robot status ahead of stale dock flags', () => {
    const vacuum = robot()
    vacuum.values.DockedStatus = 1

    vacuum.values.Operating_Mode = 6
    vacuum.values.robot_status = 6
    expect(rv3020MatterState(vacuum)).toEqual({ runMode: 1, operationalState: 1 })

    vacuum.values.Operating_Mode = 3
    vacuum.values.robot_status = 7
    expect(rv3020MatterState(vacuum)).toEqual({ runMode: 0, operationalState: 64 })

    vacuum.values.robot_status = 13
    vacuum.values.Charging_Status = 0
    expect(rv3020MatterState(vacuum)).toEqual({ runMode: 0, operationalState: 66 })

    vacuum.values.Charging_Status = 1
    expect(rv3020MatterState(vacuum)).toEqual({ runMode: 0, operationalState: 65 })
  })

  it('treats robot status 32 as starting when a clean method is desired', () => {
    const vacuum = robot()
    vacuum.values.robot_status = 32
    vacuum.values._RV3020DesiredOperatingMode = 8
    expect(rv3020MatterState(vacuum)).toEqual({ runMode: 1, operationalState: 1 })
  })

  it('keeps the older model suction and whole-house command path', async () => {
    const vacuum = robot('RVOTHER')
    const h = platform()._buildMatterHandlers({}, 'test', vacuum)
    await h.rvcCleanMode.changeToMode({ newMode: 2 })
    await h.rvcRunMode.changeToMode({ newMode: 1 })
    expect(vacuum.set_property_value).toHaveBeenCalledWith('Power_Mode', 2)
    expect(vacuum.clean_rooms).toHaveBeenCalledWith([])
    expect(vacuum.skegox.setProperty).not.toHaveBeenCalled()
  })

  it.each([6, 7, 8])('reports mode %i as running and publishes the method choices', async (mode) => {
    vi.useFakeTimers()
    const vacuum = robot()
    vacuum.values.Operating_Mode = mode
    const updateAccessoryState = vi.fn().mockResolvedValue(undefined)
    const p = platform()
    p._startVacuumPolling({ updateAccessoryState }, 'test', vacuum)
    await vi.advanceTimersByTimeAsync(0)
    expect(updateAccessoryState).toHaveBeenCalledWith('test', 'rvcRunMode', { currentMode: 1 })
    expect(updateAccessoryState).toHaveBeenCalledWith('test', 'rvcOperationalState', { operationalState: 1 })
    expect(updateAccessoryState).toHaveBeenCalledWith('test', 'rvcCleanMode', { currentMode: mode, supportedModes: RV3020_CLEAN_MODES })
    vi.clearAllTimers()
  })

  it('reports the current suction level as part of the combined Matter mode', async () => {
    vi.useFakeTimers()
    const vacuum = robot()
    vacuum.values.Operating_Mode = 6
    vacuum.values.Power_Mode = 1
    const updateAccessoryState = vi.fn().mockResolvedValue(undefined)
    const p = platform()
    p._startVacuumPolling({ updateAccessoryState }, 'test', vacuum)
    await vi.advanceTimersByTimeAsync(0)
    expect(updateAccessoryState).toHaveBeenCalledWith('test', 'rvcCleanMode', { currentMode: 16, supportedModes: RV3020_CLEAN_MODES })
    vi.clearAllTimers()
  })

  it('rebinds cached accessory handlers and updates the mode definitions', async () => {
    const p = platform()
    const vacuum = robot()
    p.vacuumDevices = [vacuum]
    p.api = { hap: { uuid: { generate: () => 'cached' } } }
    p._startVacuumPolling = vi.fn()
    const cached: any = { UUID: 'cached', clusters: { rvcCleanMode: { currentMode: 0 } } }
    p.matterAccessories.set('cached', cached)
    const registerPlatformAccessories = vi.fn()
    p._registerMatterDevices({ registerPlatformAccessories })
    expect(registerPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [cached])
    expect(cached.clusters.rvcCleanMode.supportedModes).toEqual(RV3020_CLEAN_MODES)
    expect(cached.clusters.serviceArea.supportedAreas[0].areaInfo.locationInfo.locationName).toBe('Kitchen')
    await cached.handlers.rvcRunMode.changeToMode({ newMode: 1 })
    expect(vacuum.skegox.setProperty).toHaveBeenCalledWith('TEST', 'Operating_Mode', 6)
  })
})

describe('rV3020 API metadata and logging', () => {
  it('extracts the model and desired method without exposing the device response in logs', async () => {
    const log = { debug: vi.fn() } as any
    const api = new SkegoxApi(log, 'unused') as any
    api.household_id = 'TEST'
    api.dsn_to_device_id.set('TEST', 'TEST')
    const response = {
      registry: { Device_Model_Number: 'RV3020XEUS', ipAddress: 'PRIVATE_NETWORK' },
      secret: 'PRIVATE_COMMISSIONING',
      shadow: { properties: {
        desired: { Operating_Mode: { value: 8 } },
        reported: { Operating_Mode: { value: 7 }, auth_key: { value: 'PRIVATE_AUTH' } },
      } },
    }
    api.request = vi.fn().mockResolvedValue(response)
    expect(await api.getPropertyValues('test')).toMatchObject({ Device_Model_Number: 'RV3020XEUS', _RV3020DesiredOperatingMode: 8, Operating_Mode: 7 })
    await api.setProperty('test', 'Operating_Mode', 6)
    expect(api.state_cache.has('TEST')).toBe(false)
    const logs = JSON.stringify(log.debug.mock.calls)
    expect(logs).toContain('RV3020XEUS')
    expect(logs).not.toContain('PRIVATE_')
    expect(selectCleaningDiagnostics({ auth_key: 'secret', Power_Mode: { value: 0, updatedAt: 'timestamp', extra: 'secret' } }))
      .toEqual({ Power_Mode: { value: 0, updatedAt: 'timestamp' } })
  })
})
