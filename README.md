# Skills Repository

This repository contains **14 skills** and **91 tools** for the organization's AI agent platform.

---

## Tools

| Category | Tools |
|---|---|
| **Network** | `checkConnectivity`, `checkVpnStatus`, `checkFirewallStatus`, `checkProxySettings`, `checkNtpStatus`, `checkNetworkExtension`, `flushDnsCache`, `getNetworkInterfaces`, `getWifiInfo`, `forgetWifiNetwork`, `reconnectVpn`, `renewDhcpLease`, `getVpnProfiles` |
| **System Health** | `getCpuTemperature`, `getMemoryPressure`, `getDiskUsage`, `getTopConsumers`, `getProcesses`, `getStartupItems`, `diskScan`, `syncSystemTime` |
| **Security & Identity** | `checkFileVaultStatus`, `checkSipStatus`, `checkMdmEnrollment`, `checkKerberosTicket`, `checkCertificateExpiry`, `checkPasswordExpiry`, `listClientCertificates`, `repairKeychain`, `purgeCachedCredentials`, `renewKerberosTicket`, `verifySsoAuth`, `detectIdentityProvider`, `checkAgentHeartbeat`, `resyncIdpAgent`, `resetLocalPassword` |
| **Hardware & Devices** | `listUsbDevices`, `listAudioDevices`, `listBluetoothDevices`, `listVideoDevices`, `resetBluetoothModule`, `resetAvDeviceSelection` |
| **Printing** | `listPrinters`, `addPrinter`, `removePrinter`, `checkPrinterConnectivity`, `checkPrintQueue`, `clearPrintQueue`, `restartCups`, `resetPrintingSystem` |
| **Applications** | `checkAppIntegrity`, `checkAppPermissions`, `checkSystemExtension`, `checkAgentProcess`, `checkAgentLogs`, `getAgentVersion`, `listInstalledApps`, `clearAppCache`, `resetAppPreferences`, `uninstallApp`, `downloadInstaller`, `disableStartupItem` |
| **Email & Collaboration** | `checkMailAccountConfig`, `checkMailPermissions`, `checkSmtpConnectivity`, `rebuildMailIndex`, `repairOutlookDatabase`, `checkCollabAppStatus`, `clearCollabAppCache` |
| **Cloud & Sync** | `checkCloudSyncStatus`, `pauseResumeCloudSync`, `checkTimemachineStatus` |
| **Developer Tools** | `clearDevCache`, `clearXcodeDerivedData`, `pruneDocker` |
| **File Management** | `getLargeFiles`, `findDuplicateFiles`, `findOldDownloads`, `deleteFiles`, `emptyTrash` |
| **Browser & Auth** | `clearBrowserCache`, `clearBrowserSsoCookies` |
| **Identity Provider** | `openIdpSsprPortal`, `probeIdpSsprAvailable`, `requestIdemeumIdpReset`, `getAccountInfo` |
| **Processes** | `restartProcess`, `killProcess`, `waitForUserAck` |

---

## Skills

| Skill | Description |
|---|---|
| `av-peripheral-repair` | Diagnoses and repairs external monitors, USB hubs/docks, Bluetooth audio, and webcam issues |
| `cloud-idp-password-reset` | Guides users through cloud identity provider password reset flows |
| `cloud-sync-backup-repair` | Diagnoses and repairs iCloud, OneDrive, or Dropbox sync failures |
| `collab-app-repair` | Fixes Zoom, Teams, and Slack audio, video, and sign-in issues |
| `disk-cleanup` | Identifies and removes large files, duplicates, caches, and old downloads |
| `email-repair` | Repairs mail account config, SMTP connectivity, permissions, and local database issues |
| `identity-auth-repair` | Resolves SSO, Kerberos, certificate, and MDM enrollment problems |
| `network-reset` | Full network stack diagnostic and reset workflow |
| `password-reset` | Coordinates local and IdP password reset with keychain cleanup |
| `printer-repair` | End-to-end printer diagnosis covering connectivity, queue, driver, and CUPS |
| `process-manager` | Identifies and manages runaway or stuck processes |
| `security-agent-repair` | Repairs the security agent process, heartbeat, and MDM sync |
| `software-reinstall` | Downloads and reinstalls managed applications |
| `vpn-repair` | Diagnoses VPN profiles, connectivity, and network extension issues |
