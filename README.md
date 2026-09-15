<p align="center">
   <a href="https://github.com/homebridge-plugins/homebridge-sharkiq"><img alt="homebridge-sharkiq" src="https://raw.githubusercontent.com/homebridge-plugins/homebridge-sharkiq/latest/branding/Homebridge_x_SharkIQ.png" width="600px"></a>
</p>
<span align="center">

## homebridge-sharkiq

**mj261 fork:** RV3020XEUS Vacuum / Mop / Vacuum + Mop support, maintained in
source with regression tests. See [fork installation, releases, and upstream
updates](FORK.md). Install this fork's built packages; ordinary SharkIQ registry
updates can replace these changes.

Homebridge plugin to integrate Shark IQ robot vacuums into HomeKit

[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-sharkiq/latest?label=latest)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-sharkiq)
[![npm](https://img.shields.io/npm/v/@homebridge-plugins/homebridge-sharkiq/beta?label=beta)](https://github.com/homebridge/homebridge/wiki/How-to-Install-Alternate-Plugin-Versions)<br>
[![npm](https://img.shields.io/npm/dt/@homebridge-plugins/homebridge-sharkiq)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-sharkiq)
[![Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=hb-discord)](https://discord.gg/bHjKNkN)

</span>

### Plugin Information

- This plugin allows you to view and control your Shark IQ robot vacuums within HomeKit. The plugin:
  - connects to SharkNinja's cloud (which runs on the Ayla Networks platform) to discover and control your robots
  - supports both the US and EU regions
  - can optionally expose robots over Matter as well as HomeKit

### Prerequisites

- To use this plugin, you will need to already have:
  - [Node](https://nodejs.org): latest version of `v22`, `v24` or `v26` - any other major version is not supported.
  - [Homebridge](https://homebridge.io): `v2` - refer to link for more information and installation instructions.
  - A Shark IQ robot vacuum set up in the SharkClean app.

### Setup

- [Installation](https://github.com/homebridge-plugins/homebridge-sharkiq/wiki/Installation)
- [Configuration](https://github.com/homebridge-plugins/homebridge-sharkiq/wiki/Configuration)
- [Beta Version](https://github.com/homebridge-plugins/homebridge-sharkiq/wiki/Beta-Version)
- [Node Version](https://github.com/homebridge-plugins/homebridge-sharkiq/wiki/Node-Version)

### Features

- A switch to start and stop a clean
- A fan control reflecting the robot's running state
- A contact sensor that reports when the robot is docked

### Help/About

- [Common Errors](https://github.com/homebridge-plugins/homebridge-sharkiq/wiki/Common-Errors)
- [Support Request](https://github.com/homebridge-plugins/homebridge-sharkiq/issues/new/choose)
- [Changelog](https://github.com/homebridge-plugins/homebridge-sharkiq/blob/latest/CHANGELOG.md)

### Credits

- To Bubba8291: the original creator of this plugin.
- To the creators/contributors of [Homebridge](https://homebridge.io) who make this plugin possible.

### Disclaimer

- I am in no way affiliated with SharkNinja and this plugin is a personal project that I maintain in my free time.
- Use this plugin entirely at your own risk - please see licence for more information.
