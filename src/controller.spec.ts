import type { Logger } from 'homebridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake node-screenlogic: every UnitConnection records what the controller does to it.
const mocks = vi.hoisted(() => {
  const state = {
    connections: [] as FakeConnection[],
    units: [] as unknown[],
    remote: { gatewayFound: true, ipAddr: '10.0.0.5', port: 80 } as Record<string, unknown>,
    failOperation: false,
  }

  class FakeConnection {
    systemName = ''
    initArgs: unknown[] = []
    initUnitArg: unknown
    closed = false
    connected = false
    calls: [string, ...unknown[]][] = []

    init(...args: unknown[]) {
      this.initArgs = args
      this.systemName = args[0] as string
    }
    initUnit(unit: { gatewayName: string }) {
      this.initUnitArg = unit
      this.systemName = unit.gatewayName
    }
    async connectAsync() {
      this.connected = true
      return true
    }
    async closeAsync() {
      this.closed = true
      return true
    }
    async getVersionAsync() {
      return { version: 'POOL: 5.2 Build 738.0 Rel' }
    }
    private op(name: string) {
      return async (...args: unknown[]) => {
        this.calls.push([name, ...args])
        if (state.failOperation) {
          throw new Error('boom')
        }
        return { val: true }
      }
    }
    circuits = {
      setCircuitStateAsync: this.op('setCircuitState'),
      sendLightCommandAsync: this.op('sendLightCommand'),
    }
    bodies = {
      setSetPointAsync: this.op('setSetPoint'),
      setHeatModeAsync: this.op('setHeatMode'),
    }
    equipment = {
      getControllerConfigAsync: async () => state.config,
      getEquipmentStateAsync: async () => state.status,
    }
    constructor() {
      state.connections.push(this)
    }
  }

  return { state: state as typeof state & { config?: unknown; status?: unknown }, FakeConnection }
})

vi.mock('node-screenlogic', () => ({
  UnitConnection: mocks.FakeConnection,
  FindUnits: class {
    searchAsync = async () => mocks.state.units
  },
  RemoteLogin: class {
    connectAsync = async () => mocks.state.remote
    closeAsync = async () => true
  },
  // enum values the plugin imports as types only, but keep the module shape realistic
  LightCommands: {},
}))

import { Controller, ControllerError, PoolConfig, PoolStatus } from './controller'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const makeController = (opts: Record<string, unknown> = {}) =>
  new Controller({ log: log as unknown as Logger, ...opts })

// shaped like the 2.x responses, where circuit ids are relative to 1
const controllerConfig = {
  degC: false,
  minSetPoint: [40, 41],
  maxSetPoint: [104, 103],
  circuitArray: [
    { circuitId: 1, name: 'Spa', interface: 1 },
    { circuitId: 6, name: 'Pool', interface: 0 },
    { circuitId: 3, name: 'Spa Light', interface: 3 },
  ],
}
const equipmentState = {
  airTemp: 75,
  circuitArray: [
    { id: 1, state: 0 },
    { id: 6, state: 1 },
    { id: 3, state: 0 },
  ],
  bodies: [
    { currentTemp: 70, setPoint: 103, heatStatus: 0, heatMode: 0 },
    { currentTemp: 99, setPoint: 99, heatStatus: 1, heatMode: 3 },
  ],
}

beforeEach(() => {
  mocks.state.connections.length = 0
  mocks.state.units = []
  mocks.state.remote = { gatewayFound: true, ipAddr: '10.0.0.5', port: 80 }
  mocks.state.failOperation = false
  mocks.state.config = controllerConfig
  mocks.state.status = equipmentState
})

describe('PoolConfig', () => {
  const config = new PoolConfig('Pentair: AB-CD-EF', '5.2', controllerConfig as never)

  it('restores protocol circuit ids (500-based) from the 1-based ids node-screenlogic 2.x reports', () => {
    expect(config.circuits.map((c) => c.id)).toEqual([500, 505, 502])
  })

  it('keeps names and categories', () => {
    expect(config.circuits[2]).toMatchObject({ name: 'Spa Light', category: 3 })
  })

  it('derives device id, pool/spa presence and set point limits', () => {
    expect(config.deviceId).toBe('AB-CD-EF')
    expect(config.hasPool).toBe(true)
    expect(config.hasSpa).toBe(true)
    expect([config.poolMinSetPoint, config.poolMaxSetPoint]).toEqual([40, 104])
    expect([config.spaMinSetPoint, config.spaMaxSetPoint]).toEqual([41, 103])
  })

  it('does not report a spa when the controller has none', () => {
    const noSpa = {
      ...controllerConfig,
      circuitArray: [{ circuitId: 6, name: 'Pool', interface: 0 }],
    }
    const c = new PoolConfig('Pentair: AB-CD-EF', '5.2', noSpa as never)
    expect(c.hasSpa).toBe(false)
    expect(c.hasPool).toBe(true)
  })
})

describe('PoolStatus', () => {
  const status = new PoolStatus(equipmentState as never)

  it('keys circuit state by protocol circuit id', () => {
    expect([...status.circuitState]).toEqual([
      [500, 0],
      [505, 1],
      [502, 0],
    ])
  })

  it('maps pool and spa body values', () => {
    expect(status).toMatchObject({
      poolTemperature: 70,
      poolSetPoint: 103,
      poolHeatMode: 0,
      isPoolHeating: false,
      spaTemperature: 99,
      spaSetPoint: 99,
      spaHeatMode: 3,
      isSpaHeating: true,
      airTemperature: 75,
    })
  })

  it('derives active state from the pool and spa circuits', () => {
    expect(status.isPoolActive).toBe(true)
    expect(status.isSpaActive).toBe(false)
  })

  it('tolerates a controller with only one body', () => {
    const single = {
      ...equipmentState,
      bodies: [equipmentState.bodies[0]],
      circuitArray: [{ id: 6, state: 0 }],
    }
    const s = new PoolStatus(single as never)
    expect(s.hasSpa).toBe(false)
    expect(s.isSpaActive).toBe(false)
    expect(s.isSpaHeating).toBe(false)
  })
})

describe('Controller reads', () => {
  it('getPoolConfig returns the version and mapped config, then closes', async () => {
    const config = await makeController({ ip_address: '10.0.0.9' }).getPoolConfig()
    expect(config.softwareVersion).toBe('POOL: 5.2 Build 738.0 Rel')
    expect(config.circuits.map((c) => c.id)).toEqual([500, 505, 502])
    expect(mocks.state.connections[0]).toMatchObject({ connected: true, closed: true })
  })

  it('getPoolStatus returns mapped status', async () => {
    const status = await makeController({ ip_address: '10.0.0.9' }).getPoolStatus()
    expect(status.circuitState.get(505)).toBe(1)
  })
})

describe('Controller writes', () => {
  const controller = () => makeController({ ip_address: '10.0.0.9' })
  const lastCalls = () => mocks.state.connections[0].calls

  it('converts protocol circuit ids back to 1-based ids', async () => {
    await controller().setCircuitState(502, true)
    expect(lastCalls()).toEqual([['setCircuitState', 3, true]])
  })

  it('passes pool/spa body index and set point through', async () => {
    await controller().setHeatPoint(1, 97)
    expect(lastCalls()).toEqual([['setSetPoint', 1, 97]])
  })

  it('passes heat mode through', async () => {
    await controller().setHeatMode(0, 3)
    expect(lastCalls()).toEqual([['setHeatMode', 0, 3]])
  })

  it('sends light commands', async () => {
    await controller().sendLightCommand(13)
    expect(lastCalls()).toEqual([['sendLightCommand', 13]])
  })

  it('closes the connection and rethrows when the operation fails', async () => {
    mocks.state.failOperation = true
    await expect(controller().setCircuitState(500, true)).rejects.toThrow('boom')
    expect(mocks.state.connections[0].closed).toBe(true)
  })
})

describe('Controller connection modes', () => {
  it('static ip: uses the configured address, port 80 by default, and username as name', async () => {
    await makeController({ ip_address: '10.0.0.9', username: 'Pentair: AA-BB-CC' }).getPoolStatus()
    expect(mocks.state.connections[0].initArgs).toEqual([
      'Pentair: AA-BB-CC',
      '10.0.0.9',
      80,
      undefined,
    ])
  })

  it('static ip: honours port and password, and falls back to a placeholder name', async () => {
    await makeController({ ip_address: '10.0.0.9', port: 8080, password: 'pw' }).getPoolStatus()
    expect(mocks.state.connections[0].initArgs).toEqual([
      'Pentair: XX-XX-XX',
      '10.0.0.9',
      8080,
      'pw',
    ])
  })

  it('broadcast: connects to the first unit found', async () => {
    mocks.state.units = [{ gatewayName: 'Pentair: 11-22-33' }, { gatewayName: 'Pentair: 44-55-66' }]
    const config = await makeController().getPoolConfig()
    expect(config.gatewayName).toBe('Pentair: 11-22-33')
  })

  it('broadcast: fails clearly when nothing answers', async () => {
    await expect(makeController().getPoolStatus()).rejects.toThrow(ControllerError)
    await expect(makeController().getPoolStatus()).rejects.toThrow('no local unit found')
  })

  it('remote login: connects to the address the gateway reports', async () => {
    await makeController({ username: 'Pentair: AA-BB-CC', password: 'pw' }).getPoolStatus()
    expect(mocks.state.connections[0].initArgs).toEqual(['Pentair: AA-BB-CC', '10.0.0.5', 80, 'pw'])
  })

  it('remote login: fails clearly when the gateway is not found', async () => {
    mocks.state.remote = { gatewayFound: false }
    await expect(
      makeController({ username: 'Pentair: AA-BB-CC', password: 'pw' }).getPoolStatus(),
    ).rejects.toThrow('no remote unit found')
  })

  it('a static ip wins over remote credentials', async () => {
    await makeController({ ip_address: '10.0.0.9', username: 'u', password: 'pw' }).getPoolStatus()
    expect(mocks.state.connections[0].initArgs[1]).toBe('10.0.0.9')
  })
})
