# Changelog

All notable changes to MelPump for Homey are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses
[Semantic Versioning](https://semver.org/). The short texts shown in the Homey App Store are in
`.homeychangelog.json`.

## [Unreleased]

## [1.2.1] - 2026-11-26

### Changed

- App Store listing: a new one-line description, a photo as the app image, store texts without setup
  instructions, and widget previews drawn as simple shapes.

## [1.2.0] - 2026-11-22

### Added

- App settings page (Apps → MelPump → Configure app): the status of every heat pump, whether its
  token works, requests and errors, functions that end automatically, the latest alarms and log
  lines, and a diagnostics text to copy into a bug report. The API token is never shown.
- Alarm history: MelPump only lists today's alarms, so the app keeps its own for 90 days.
- New value: MelPump alarms in the last 7 days.

### Fixed

- An unexpected answer from melpump.com, such as a maintenance page, no longer removes zone 2 or the
  cooling and thermostat values (which lost their Insights history and broke their Flows).
- Last month's figures and the year total no longer stay too low when the month was counted before
  MelPump published its last day. Months stored by earlier versions are fetched again once.
- Power, heat output, compressor and heater values are cleared while the heat pump is offline or
  MelPump has no data, so Homey Energy no longer counts the last power.
- Alarms in the last minutes of the day are no longer missed.
- The "subscription is not active" warning goes as soon as the subscription is renewed, instead of
  up to 6 hours later.
- "Room temperature deviates" fires once with a wait of 180 minutes (it never fired at 180, and
  fired every minute just below).
- "Compressor started N times within an hour" no longer fires at every start while the compressor
  keeps that rate; at most once an hour.
- "Force solar mode until a time" ends at that time also when the clocks change for daylight saving.
- "Holiday until" is no longer empty after hiding and showing the switches.
- A widget whose heat pump was removed asks to choose another one, instead of showing a different
  heat pump.

### Development

- The device code is split by topic over `drivers/heatpump/lib/`.
- ESLint, Node 22 (`.nvmrc`), test coverage limits, and CI on the current GitHub actions.
- The tests run against a stand-in for Homey that checks Flow cards, tokens, capability values and
  translations, and cover every Flow card, pairing and repair.

## [1.1.1] - 2026-11-04

### Changed

- **Breaking:** the app id is now `io.github.marlark.melpump` instead of `com.melpump.homey`, so the
  unofficial app no longer looks like it comes from MelPump. Remove the old app, install this version
  and pair your heat pumps again.
- Homepage, support, bugs and source links point to the GitHub repository.

### Fixed

- Pairing and repair finish right away instead of waiting for the first poll.
- Repairing a heat pump also updates other heat pumps that use the same token.
- A failed zone 2 change no longer counts as a failed poll.
- A hot water boost or holiday mode that can't be switched off at its end time is retried up to
  5 times, and then you get a notification.

## [1.1.0] - 2026-11-02

### Added

- Widget: today's figures, a 24-hour power graph, hot water progress, warnings and alarms, data age,
  a compact layout and optional quick buttons, with instant updates.

### Changed

- Changes made from Homey show up within about 20 seconds.
- Temperature sliders send only the final value.
- Fewer requests while MelPump can't be reached.
- Lower memory use.

## [1.0.0]

### Added

- First release: live temperatures, COP and power, Homey Energy, saving / solar / night mode
  statistics, alarms, a dashboard widget and Flow cards to control the heat pump through MelPump,
  in English, Dutch, Swedish, German, Danish and Norwegian.

[Unreleased]: https://github.com/Marlark/melpump-homey/compare/5d7f172...HEAD
[1.2.1]: https://github.com/Marlark/melpump-homey/compare/91f1b54...5d7f172
[1.2.0]: https://github.com/Marlark/melpump-homey/compare/16f20a5...91f1b54
[1.1.1]: https://github.com/Marlark/melpump-homey/compare/5bccdc8...16f20a5
[1.1.0]: https://github.com/Marlark/melpump-homey/commit/5bccdc8
