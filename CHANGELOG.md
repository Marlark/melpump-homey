# Changelog

All notable changes to MelPump for Homey are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses
[Semantic Versioning](https://semver.org/).

The short texts shown in the Homey App Store are kept in `.homeychangelog.json`.

## [Unreleased]

## [1.2.0] - 2026-11-22

### Added

- App settings page (Apps → MelPump → Configure app): every heat pump's status, whether its token
  works, requests and errors, functions that end automatically, and a diagnostics text to copy into a
  bug report (without the API token).
- Alarm history: MelPump only lists today's alarms, so the app keeps its own for 90 days. The settings
  page shows the latest, and the new value "MelPump alarms, last 7 days" counts them.
- The app's last 200 log lines on the settings page and in the diagnostics.

### Changed

- The heat pump device code is split by topic over `drivers/heatpump/lib/` (no change in behavior).
- The tests use a stand-in for Homey that checks Flow cards, trigger tokens, capability values and
  translations like Homey does.
- Development: ESLint (`npm run lint`), a test coverage limit (`npm run test:coverage`), Node 22 in
  `.nvmrc` and `engines`, and CI on the current versions of the GitHub actions.
- Tests for every Flow card, pairing and repair, the live state and MelPump's settings; the coverage
  limits are raised to 94 % of lines, 88 % of branches and 82 % of functions.

### Fixed

- A response from melpump.com that isn't the heat pump (such as a maintenance page) or lacks some
  fields no longer removes zone 2 or the cooling and thermostat values, which would have lost their
  Insights history and broken the Flows using them.
- Last month's figures and the year total no longer stay too low when the month is counted before
  MelPump has published its last day. Months cached by earlier versions are fetched again once.
  The same wait applies to this month's figures and the 30-day SCOP.
- "Room temperature deviates" with a wait of 180 minutes now fires once, instead of never (180) or
  at every reading (just under 180).
- An alarm in the last minutes of the day is no longer missed: MelPump's alarm list only covers
  today, so alarms are also checked at each of the last 3 minutes before midnight (heat pump time).
- The "MelPump subscription is not active" warning now goes at the first poll after the subscription
  is renewed, instead of up to 6 hours later.
- "Compressor started N times within an hour" no longer fires at every start while the compressor
  keeps starting at exactly that rate; it fires again after an hour at the earliest.
- "Holiday until" is no longer empty after hiding and showing the switches in the device settings.
- "Force solar mode until a time" counts the real time when the clocks change for daylight saving
  in between, so solar mode ends at the chosen time.
- Power, heat output, compressor frequency, flow rate, defrost and heaters are cleared while the heat
  pump is offline or MelPump has no data, instead of showing the last reading. Homey Energy no longer
  counts the last power, and "compressor is running" is no longer true. The COP keeps its last value.
- A widget whose heat pump has been removed asks to choose another one, instead of quietly showing
  a different heat pump.
- The log line for a newly added sensor shows the value the heat pump reports.

## [1.1.1] - 2026-11-04

### Changed

- **Breaking:** the app id is now `io.github.marlark.melpump` instead of `com.melpump.homey`, so the
  unofficial app no longer looks like it comes from MelPump. Remove the old app, install this version
  and pair your heat pumps again.
- Homepage, support, bugs and source links point to the GitHub repository.

### Fixed

- Pairing and repair finish right away instead of waiting for the first poll.
- Repairing a heat pump also updates other heat pumps that use the same token.
- A failed zone 2 capability change no longer counts as a failed poll.
- A hot water boost or holiday mode that can't be switched off at its end time is retried up to
  5 times, waits while requests are paused or melpump.com can't be reached, and then sends a
  notification.

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
  statistics, alarms, a dashboard widget and Flow cards to control the heat pump through MelPump.
- Translations in English, Dutch, Swedish, German, Danish and Norwegian.

[Unreleased]: https://github.com/Marlark/melpump-homey/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Marlark/melpump-homey/compare/16f20a5...v1.2.0
[1.1.1]: https://github.com/Marlark/melpump-homey/compare/5bccdc8...16f20a5
[1.1.0]: https://github.com/Marlark/melpump-homey/commit/5bccdc8
