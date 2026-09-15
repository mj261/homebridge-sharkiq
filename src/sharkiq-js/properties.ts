// Power Modes ENUM
const PowerModes = {
  ECO: 1,
  NORMAL: 0,
  MAX: 2,
}

// Operating Modes ENUM
const OperatingModes = {
  STOP: 0,
  PAUSE: 1,
  START: 2,
  RETURN: 3,
}

// Common properties for Vacuum ENUM
const Properties = {
  AREAS_TO_CLEAN: 'AreasToClean_V2',
  BATTERY_CAPACITY: 'Battery_Capacity',
  CHARGING_STATUS: 'Charging_Status',
  CLEAN_COMPLETE: 'CleanComplete',
  CLEANING_STATISTICS: 'Cleaning_Statistics',
  DOCK_ERROR_CODE: 'DockErrorCode',
  DOCK_SENSOR_DATA: 'DockSensorData',
  DOCKED_STATUS: 'DockedStatus',
  ERROR_CODE: 'Error_Code',
  EVACUATING: 'Evacuating',
  EXTENDED_ERROR_CODE: 'Extended_Error_Code',
  FIND_DEVICE: 'Find_Device',
  LIVE_LOCATION: 'LiveLocation',
  LIVE_PROGRESS: 'live_progress',
  LOW_LIGHT_MISSION: 'LowLightMission',
  MOP_PLATE_ATTACHED: 'MopPlateAttached',
  NAV_MODULE_FW_VERSION: 'Nav_Module_FW_Version',
  OPERATING_MODE: 'Operating_Mode',
  OPERATING_MODE_EX: 'Operating_Mode_Ex',
  PAD_DRY: 'pad_dry',
  PAD_WASH: 'pad_wash',
  POWER_MODE: 'Power_Mode',
  PUMP_GREY_WATER: 'pump_grey_water',
  RECHARGE_RESUME: 'Recharge_Resume',
  RECHARGING_TO_RESUME: 'Recharging_To_Resume',
  REFILL_RESUME: 'refill_resume',
  REFILL_RESUME_STATUS: 'refill_resume_status',
  REFILLING: 'Refilling',
  ROBOT_FIRMWARE_VERSION: 'Robot_Firmware_Version',
  ROBOT_ROOM_LIST: 'Robot_Room_List',
  ROBOT_STATUS: 'robot_status',
  MISSION_STATE: 'mission_state',
  RSSI: 'RSSI',
  DEVICE_MODEL_NUMBER: 'Device_Model_Number',
  DEVICE_SERIAL_NUMBER: 'Device_Serial_Num',
  WATER_TANK_EMPTY: 'Water_Tank_Empty',
  WATER_TANK_INSTALLED: 'WaterTankInstalled',
  WARNING_CODE: 'Warning_Code',
}

// Error messages enum
const ERROR_MESSAGES = {
  1: 'Side wheel is stuck',
  2: 'Side brush is stuck',
  3: 'Suction motor failed',
  4: 'Brushroll stuck',
  5: 'Side wheel is stuck (2)',
  6: 'Bumper is stuck',
  7: 'Cliff sensor is blocked',
  8: 'Battery power is low',
  9: 'No Dustbin',
  10: 'Fall sensor is blocked',
  11: 'Front wheel is stuck',
  13: 'Switched off',
  14: 'Magnetic strip error',
  16: 'Top bumper is stuck',
  18: 'Wheel encoder error',
}

export { ERROR_MESSAGES, OperatingModes, PowerModes, Properties }
