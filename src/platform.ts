import type { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge'

import type { AylaApi } from './sharkiq-js/ayla_api.js'

import { join } from 'node:path'

import { TIMEOUTS } from './constants.js'
import { Login } from './login.js'
import { SharkIQAccessory } from './platformAccessory.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import { get_ayla_api } from './sharkiq-js/ayla_api.js'
import { global_vars } from './sharkiq-js/const.js'
import { Properties } from './sharkiq-js/properties.js'
import { ROOM_CLEAN_PRESETS, SharkIqVacuum } from './sharkiq-js/sharkiq.js'
import { SkegoxApi } from './sharkiq-js/skegox_api.js'
import { safeTimerMs } from './utils.js'

// SharkIQPlatform Main Class
export class SharkIQPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = []
  // Device vacuums object array
  public vacuumDevices: SharkIqVacuum[] = []

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service
    this.Characteristic = this.api.hap.Characteristic
    this.log.debug('Finished initializing platform:', this.config.name)

    // Start plugin and attempt to login
    // Stop polling on the way out, so the timers do not keep calling the cloud -
    // or hold the process open - after Homebridge has said stop
    this.api.on('shutdown', () => {
      this.shutdownPolling()
    })

    this.api.on('didFinishLaunching', () => {
      const configuredDsns = Array.isArray(config.vacuums)
        ? (config.vacuums as unknown[]).filter((dsn): dsn is string => typeof dsn === 'string' && dsn.trim() !== '')
        : []
      // With no DSNs configured, add every vacuum on the account. This is the
      // documented single-vacuum workaround for the DSN-matching problem, and it
      // needs no config at all (#64, #68).
      const addAll = configuredDsns.length === 0

      this.login().then((devices) => {
        const discovered = devices.map(device => String(device._dsn))
        log.info(`Found ${devices.length} vacuum(s) on your account: ${discovered.join(', ') || 'none'}`)

        if (addAll) {
          log.info('No vacuum DSNs configured, adding all vacuums found on your account.')
          this.vacuumDevices.push(...devices)
        } else {
          // Normalise the configured DSNs so a copy/paste from the Shark app with a
          // different case or a stray space still matches what the account returns.
          // DSNs are unique regardless of case, so this is safe (#64, #70).
          const wanted = new Set(configuredDsns.map(dsn => dsn.trim().toUpperCase()))
          for (let i = 0; i < devices.length; i++) {
            if (wanted.has(String(devices[i]._dsn).trim().toUpperCase())) {
              this.vacuumDevices.push(devices[i])
            }
          }
          if (this.vacuumDevices.length === 0) {
            log.warn(`None of the DSNs provided matched the vacuum(s) on your account. Configured: [${configuredDsns.join(', ')}], discovered: [${discovered.join(', ')}]. Leave the DSN list empty to add every vacuum on your account.`)
          }
        }
        // An empty list is not proof the account has no vacuums. Every fetch
        // failure inside the Ayla client is swallowed and returned as an empty
        // array, so the internet being down at startup used to look exactly like
        // "the owner deleted their vacuum" - and discoverDevices() then removed
        // every cached accessory, taking its room, scenes and automations with it.
        if (devices.length === 0) {
          log.warn('No vacuums came back from the SharkNinja account this time, so the existing accessories have been left alone.')
          return
        }

        this.discoverDevices()
      }).catch((error) => {
        log.error('Error with login.')
        log.error(error)
      })
    })
  }

  // Attempt to login and fetch devices.
  login = async (): Promise<SharkIqVacuum[]> => {
    const europe = this.config.europe || false
    const storagePath = this.api.user.storagePath()
    const auth_file = join(storagePath, global_vars.FILE)
    const oauth_file = join(storagePath, global_vars.OAUTH.FILE)
    const oAuthCode = this.config.oAuthCode || ''
    // There used to be an email/password path announced here. Nothing ever
    // authenticated with those values - Login.checkLogin only implements OAuth -
    // and neither key was in the settings schema, so anyone who hand-edited them
    // in was told the plugin was using them and then handed a login failure.
    if (this.config.email || this.config.password) {
      this.log.warn('Email and password are not used by this plugin. Sign in with the OAuth flow in the Homebridge UI instead.')
    }
    if (oAuthCode && typeof oAuthCode === 'string' && oAuthCode.trim() !== '') {
      this.log.info('Valid OAuth code present, using OAuth login method.')
    }

    const login = new Login(this.log, auth_file, oauth_file, oAuthCode, europe)
    try {
      await login.checkLogin()
      const ayla_api = get_ayla_api(auth_file, this.log, europe)
      await ayla_api.sign_in()
      const devices = await ayla_api.get_devices()
      const skegox = await this.enableSkegox(devices, storagePath, europe)
      // Newer vacuums can drop off the Ayla account individually. An account
      // may therefore contain an older vacuum from Ayla and a newer-API-only
      // vacuum at the same time. Merge every missing newer-API vacuum rather
      // than adopting them only when Ayla returned an entirely empty list.
      if (skegox) {
        const knownDsns = new Set(devices.map(device => device._dsn.trim().toUpperCase()))
        const newApiOnlyDevices = await this.adoptNewApiVacuums(ayla_api, skegox, europe, knownDsns)
        devices.push(...newApiOnlyDevices)
      }
      // Room cleans default to the app's plain "Clean". Matrix Clean is the
      // app's second button for a room - two passes, different mode key (#41).
      const roomCleanPreset = this.config.matrixClean ? ROOM_CLEAN_PRESETS.matrix : ROOM_CLEAN_PRESETS.standard
      devices.forEach((device) => {
        device.roomCleanOptions = { ...roomCleanPreset }
      })
      this.log.debug(`Room cleans will use ${this.config.matrixClean ? 'Matrix Clean' : 'a standard clean'}.`)
      return devices
    } catch (error) {
      return Promise.reject(error)
    }
  }

  // Connect to the newer SharkNinja device API and link each vacuum to it.
  // Newer vacuums only act on commands sent through this API, so commands are
  // routed there first when the vacuum is known to it (#68). Needs the Auth0
  // token set that the OAuth Assistant stores at sign-in - without it the
  // plugin keeps working through the Ayla API alone.
  enableSkegox = async (devices: SharkIqVacuum[], storagePath: string, europe: boolean): Promise<SkegoxApi | null> => {
    const auth0_file = join(storagePath, global_vars.AUTH0_FILE)
    try {
      const skegox = new SkegoxApi(this.log, auth0_file, europe)
      const mapped = await skegox.init()
      if (mapped > 0) {
        devices.forEach((device) => {
          device.skegox = skegox
        })
        this.log.info(`Connected to the new SharkNinja API (${mapped} vacuum(s) linked) - commands will be sent there first.`)
        return skegox
      }
      this.log.info('No vacuums found on the new SharkNinja API - commands will use the Ayla API.')
      return null
    } catch (error) {
      this.log.info(`Could not connect to the new SharkNinja API - commands will use the Ayla API. If a vacuum ignores start/stop commands, sign in again through the OAuth Assistant in the plugin settings to enable the new API. (${error})`)
      return null
    }
  }

  // Build vacuums from the newer SharkNinja API for an account the older Ayla
  // API lists nothing on. Everything these vacuums read and write goes to the
  // newer API, which is where their state lives (#91).
  adoptNewApiVacuums = async (
    ayla_api: AylaApi,
    skegox: SkegoxApi,
    europe: boolean,
    knownDsns: Iterable<string> = [],
  ): Promise<SharkIqVacuum[]> => {
    const adopted: SharkIqVacuum[] = []
    const known = new Set([...knownDsns].map(dsn => String(dsn).trim().toUpperCase()))
    for (const entry of skegox.listDevices()) {
      if (known.has(entry.dsn.trim().toUpperCase())) {
        continue
      }
      const vacuum = new SharkIqVacuum(ayla_api, {
        dsn: entry.dsn,
        // Ayla's device key and OEM model are unknown here, and nothing this
        // vacuum does needs them - every request goes to the newer API
        key: '',
        oem_model: entry.model,
        product_name: entry.name,
      }, this.log, europe)
      vacuum.skegox = skegox
      vacuum.newApiOnly = true
      await vacuum.update([])
      vacuum._update_metadata()
      // A SharkNinja account holds every appliance the brand makes, so the
      // same test the Ayla path uses decides what is a vacuum (#85)
      if (vacuum.get_property_value(Properties.OPERATING_MODE) === undefined) {
        this.log.info(`Ignoring "${entry.name}" (${entry.dsn}) - it is on the new SharkNinja API but is not a vacuum.`)
        continue
      }
      if (!vacuum._vac_model_number && entry.model) {
        vacuum._vac_model_number = entry.model
      }
      adopted.push(vacuum)
    }
    if (adopted.length > 0) {
      this.log.info(`Added ${adopted.length} vacuum(s) found only on the newer SharkNinja API.`)
    }
    return adopted
  }

  // Restore accessory cache.
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName)

    this.accessories.push(accessory)
  }

  // Stop every timer this platform started. Overridden by the Matter platform,
  // which owns its own poll timers.
  protected shutdownPolling(): void {
    this.accessories.forEach(accessory => (accessory as any).control?.shutdown?.())
  }

  // Add vacuums to Homebridge.
  discoverDevices(): void {
    const externalAccessory = this.config.externalAccessory || false
    const newAccessories: PlatformAccessory[] = []
    const activeAccessories: PlatformAccessory[] = []
    const cachedActiveAccessories: PlatformAccessory[] = []
    // A copy, not a reference. This used to alias `this.accessories`, and the
    // sweep at the end splices that same array while walking it - so with three
    // stale accessories only the middle one was actually unregistered, and the
    // other two stayed in HomeKit as ghost tiles that could never be cleaned up.
    const unusedDeviceAccessories = [...this.accessories]

    const invertDockedStatus = this.config.invertDockedStatus || false
    // Clamped: this value is used as a timer delay in milliseconds, and past
    // 2147483647 a Node timer does not throw - it quietly becomes 1 ms, which
    // would poll the vacuum a thousand times a second.
    const dockedUpdateInterval = safeTimerMs(this.config.dockedUpdateInterval || TIMEOUTS.DEFAULT_DOCKED_UPDATE_INTERVAL)
    // Off by default: each adds a tile to Home, so an existing setup must look
    // exactly as it did until someone asks for them (#88).
    const showErrorSensor = this.config.errorSensor || false
    const showWaterTankSensor = this.config.waterTankSensor || false
    const showMopPlateSensor = this.config.mopPlateSensor || false
    this.vacuumDevices.forEach((vacuumDevice) => {
      const uuid = this.api.hap.uuid.generate(vacuumDevice._dsn.toString())
      let accessory = unusedDeviceAccessories.find(accessory => accessory.UUID === uuid)

      if (accessory) {
        unusedDeviceAccessories.splice(unusedDeviceAccessories.indexOf(accessory), 1)
        cachedActiveAccessories.push(accessory)
        // Keep the name Homebridge shows in step with the account. HomeKit owns
        // the name it was first given and this cannot change that - but a
        // vacuum that came through as "unnamed" should not stay that way in the
        // logs and the UI. updateDisplayName also writes the HAP accessory's
        // copy, which a plain assignment misses; it arrived in homebridge 1.10.
        const currentName = vacuumDevice._name?.toString()
        if (currentName && currentName !== accessory.displayName && typeof (accessory as any).updateDisplayName === 'function') {
          (accessory as any).updateDisplayName(currentName)
        }
      } else {
        accessory = new this.api.platformAccessory(vacuumDevice._name.toString(), uuid)
        newAccessories.push(accessory)
      }

      let accessoryInformationService = accessory.getService(this.Service.AccessoryInformation)
      if (!accessoryInformationService) {
        accessoryInformationService = accessory.addService(this.Service.AccessoryInformation)
      }
      accessoryInformationService
        .setCharacteristic(this.Characteristic.Manufacturer, 'Shark')
        .setCharacteristic(this.Characteristic.Model, vacuumDevice._vac_model_number || 'Unknown')
        .setCharacteristic(this.Characteristic.SerialNumber, vacuumDevice._dsn)

      activeAccessories.push(accessory);
      (accessory as any).control = new SharkIQAccessory(this, accessory, vacuumDevice, this.api.hap.uuid, this.log, invertDockedStatus, dockedUpdateInterval, showErrorSensor, showWaterTankSensor, showMopPlateSensor)
    })

    if (externalAccessory) {
      if (cachedActiveAccessories.length > 0) {
        this.log.info(`Unregistering ${cachedActiveAccessories.length} bridged accessory(ies) before external publishing.`)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, cachedActiveAccessories)
        cachedActiveAccessories.forEach((cachedAccessory) => {
          const index = this.accessories.indexOf(cachedAccessory)
          if (index >= 0) {
            this.accessories.splice(index, 1)
          }
        })
      }

      // Publish all active accessories (new and cached) as external standalone devices.
      // Each will have its own pairing code and appear independently in HomeKit.
      this.log.info(`Publishing ${activeAccessories.length} vacuum(s) as external accessory(ies).`)
      this.api.publishExternalAccessories(PLUGIN_NAME, activeAccessories)
    } else {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories)
    }

    if (unusedDeviceAccessories.length > 0) {
      unusedDeviceAccessories.forEach((unusedDeviceAccessory) => {
        this.log.info(`Removing unused accessory with name ${unusedDeviceAccessory.displayName}`)
        const index = this.accessories.indexOf(unusedDeviceAccessory)
        if (index >= 0) {
          this.accessories.splice(index, 1)
        }
      })

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, unusedDeviceAccessories)
    }
  }
}
