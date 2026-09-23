# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/) from 0.1.

## [Unreleased]

### Added
- Repository scaffold, design notebook and initial ADRs.
- Core vertical slice: `defineConnector`, `execute` (validate, auth, HTTP, error normalization), `createConnectorKit().connect()`.
- GitHub connector with `repos.get`.
