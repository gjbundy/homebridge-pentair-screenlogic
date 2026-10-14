import {
  BodyIndex,
  FindUnits,
  HeatModes,
  LightCommands,
  RemoteLogin,
  SLControllerConfigData,
  SLEquipmentStateData,
  UnitConnection,
} from 'node-screenlogic'
import { Logger } from 'homebridge'

interface ControllerOptions {
  log: Logger
  ip_address?: string
  port?: number
  username?: string
  password?: string
}

/**
 * config options:
 * 1. UDP broadcast to find unit:
 *   config = {}
 * 2. find unit by static IP address.
 *   config = {
 *     ip_address: "n.n.n.n",
 *     username: "Pentair: XX-XX-XX" // optional
 *   }
 * 3. login via Pentrair remote gateway
 *   config = {
 *     username: "Pentair: XX-XX-XX",
 *     password: "..."
 *   }
 */
export class Controller {
  /**
   * node-screenlogic 2.x reports circuit ids relative to 1 (1, 2, ...) while 1.x and the
   * ScreenLogic protocol use 500, 501, .... We keep the protocol ids everywhere in the plugin so
   * existing accessories (whose UUIDs include the circuit id) and user config remain valid.
   */
  static readonly CIRCUIT_ID_OFFSET = 499

  static readonly SPA_CIRCUIT_ID = 500
  static readonly POOL_CIRCUIT_ID = 505

  static readonly HEAT_MODE_OFF = 0
  static readonly HEAT_MODE_SOLAR = 1
  static readonly HEAT_MODE_SOLAR_PREFERRED = 2
  static readonly HEAT_MODE_HEAT_PUMP = 3
  static readonly HEAT_MODE_UNCHANGED = 4

  private readonly log: Logger
  private readonly ip_address?: string
  private readonly port?: number
  private readonly username?: string
  private readonly password?: string

  constructor(settings: ControllerOptions) {
    this.log = settings.log
    this.ip_address = settings.ip_address
    this.port = settings.port
    this.username = settings.username
    this.password = settings.password
  }

  async getPoolConfig(): Promise<PoolConfig> {
    return this._withConnection(async (connection) => {
      const { version } = await connection.getVersionAsync()
      const config = await connection.equipment.getControllerConfigAsync()
      this.log.debug('controllerConfig', config)
      return new PoolConfig(connection.systemName, version, config)
    })
  }

  async getPoolStatus(): Promise<PoolStatus> {
    return this._withConnection(async (connection) => {
      return new PoolStatus(await connection.equipment.getEquipmentStateAsync())
    })
  }

  async setCircuitState(circuitId: number, circuitState: boolean): Promise<void> {
    await this._withConnection((connection) =>
      connection.circuits.setCircuitStateAsync(
        circuitId - Controller.CIRCUIT_ID_OFFSET,
        circuitState,
      ),
    )
  }

  async setHeatPoint(bodyType: number, heatPoint: number): Promise<void> {
    await this._withConnection((connection) =>
      connection.bodies.setSetPointAsync(bodyType as BodyIndex, heatPoint),
    )
  }

  async sendLightCommand(cmd: LightCommands): Promise<void> {
    await this._withConnection((connection) => connection.circuits.sendLightCommandAsync(cmd))
  }

  async setHeatMode(bodyType: number, heatMode: number): Promise<void> {
    await this._withConnection((connection) =>
      connection.bodies.setHeatModeAsync(bodyType as BodyIndex, heatMode as HeatModes),
    )
  }

  /** open a connection, log in, run the operation, and always close the connection */
  private async _withConnection<T>(
    operation: (connection: UnitConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this._getConnection()
    try {
      await connection.connectAsync()
      return await operation(connection)
    } finally {
      await connection.closeAsync().catch((err) => this.log.debug('error closing connection:', err))
    }
  }

  private async _getConnection(): Promise<UnitConnection> {
    if (this.ip_address) {
      return this._getConnectionByIPAddress(this.ip_address)
    } else if (this.username && this.password) {
      return this._getConnectionByRemoteLogin(this.username, this.password)
    } else {
      return this._getConnectionByBroadcast()
    }
  }

  /** get a connection by udp broadcast */
  private async _getConnectionByBroadcast(): Promise<UnitConnection> {
    const units = await new FindUnits().searchAsync()
    if (units.length === 0) {
      throw new ControllerError('no local unit found')
    }
    const connection = new UnitConnection()
    connection.initUnit(units[0])
    return connection
  }

  /** get a connection by IP address */
  private async _getConnectionByIPAddress(ipAddress: string): Promise<UnitConnection> {
    const connection = new UnitConnection()
    connection.init(this.username ?? 'Pentair: XX-XX-XX', ipAddress, this.port || 80, this.password)
    return connection
  }

  /** find a unit by remote login */
  private async _getConnectionByRemoteLogin(
    username: string,
    password: string,
  ): Promise<UnitConnection> {
    const remote = new RemoteLogin(username)
    const unit = await remote.connectAsync()
    await remote.closeAsync()
    if (!unit?.gatewayFound) {
      throw new ControllerError('no remote unit found')
    }
    const connection = new UnitConnection()
    connection.init(username, unit.ipAddr, unit.port, password)
    return connection
  }
}

export class ControllerError extends Error {}

export class PoolCircuit {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly category: number,
  ) {}
}

export class PoolConfig {
  public readonly gatewayName: string
  public readonly deviceId: string

  public readonly softwareVersion: string
  public readonly isCelsius: boolean
  public readonly poolMinSetPoint: number
  public readonly poolMaxSetPoint: number
  public readonly spaMinSetPoint: number
  public readonly spaMaxSetPoint: number
  public readonly hasSpa: boolean
  public readonly hasPool: boolean
  public circuits: PoolCircuit[] = []

  constructor(gatewayName: string, softwareVersion: string, config: SLControllerConfigData) {
    this.gatewayName = gatewayName
    this.deviceId = gatewayName.replace('Pentair: ', '')

    this.softwareVersion = softwareVersion
    this.isCelsius = config.degC
    this.poolMinSetPoint = config.minSetPoint[0] ?? 0
    this.poolMaxSetPoint = config.maxSetPoint[0] ?? 0
    this.spaMinSetPoint = config.minSetPoint[1] ?? 0
    this.spaMaxSetPoint = config.maxSetPoint[1] ?? 0
    this.hasSpa = false
    this.hasPool = false
    this.circuits = []
    for (const circuit of config.circuitArray) {
      const poolCircuit = new PoolCircuit(
        circuit.circuitId + Controller.CIRCUIT_ID_OFFSET,
        circuit.name,
        circuit.interface,
      )
      this.circuits.push(poolCircuit)
      if (poolCircuit.id === Controller.POOL_CIRCUIT_ID) {
        this.hasPool = true
      } else if (poolCircuit.id === Controller.SPA_CIRCUIT_ID) {
        this.hasSpa = true
      }
    }
  }
}

export class PoolStatus {
  public readonly circuitState = new Map<number, number>()

  public readonly hasPool: boolean
  public readonly poolTemperature: number
  public readonly poolSetPoint: number
  public readonly isPoolActive: boolean
  public readonly isPoolHeating: boolean
  public readonly poolHeatMode: number

  public readonly hasSpa: boolean
  public readonly spaTemperature: number
  public readonly spaSetPoint: number
  public readonly isSpaActive: boolean
  public readonly isSpaHeating: boolean
  public readonly spaHeatMode: number

  public readonly airTemperature: number

  constructor(status: SLEquipmentStateData) {
    // save circuit state
    this.circuitState = new Map()
    for (const circuit of status.circuitArray) {
      this.circuitState.set(circuit.id + Controller.CIRCUIT_ID_OFFSET, circuit.state)
    }

    this.hasPool = this.circuitState.get(Controller.POOL_CIRCUIT_ID) !== undefined
    this.hasSpa = this.circuitState.get(Controller.SPA_CIRCUIT_ID) !== undefined

    const pool = status.bodies[0]
    this.poolTemperature = pool?.currentTemp
    this.poolSetPoint = pool?.setPoint
    this.isPoolActive = this.hasPool && this.circuitState.get(Controller.POOL_CIRCUIT_ID) === 1
    this.isPoolHeating = this.hasPool && pool?.heatStatus !== 0
    this.poolHeatMode = pool?.heatMode

    const spa = status.bodies[1]
    this.spaTemperature = spa?.currentTemp
    this.spaSetPoint = spa?.setPoint
    this.isSpaActive = this.hasSpa && this.circuitState.get(Controller.SPA_CIRCUIT_ID) === 1
    this.isSpaHeating = this.hasSpa && spa?.heatStatus !== 0
    this.spaHeatMode = spa?.heatMode

    this.airTemperature = status.airTemp
  }
}
