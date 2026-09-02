---
name: bluetooth-device-repair
description: Diagnoses and fixes Bluetooth peripherals that will not connect or that keep dropping out. Use when the user reports a Bluetooth headset, keyboard, mouse, or speaker is not connecting or keeps disconnecting.
allowed-tools:
  - list_bluetooth_devices
  - wait_for_user_ack
  - reset_bluetooth_module
metadata:
  prerequisites:
    before-corrective:
      - list_bluetooth_devices
  maxAggregateRisk: medium
  userLabel: "Fix a Bluetooth device that won't connect"
  pill:
    label: Fix Bluetooth devices
    goal: My Bluetooth device won't connect, diagnose and fix.
    icon: Headphones
    iconClass: text-sky-500
    order: 13
  examples:
    - "bluetooth isn't working"
    - "my bluetooth device won't connect"
    - "my bluetooth headphones won't connect"
    - "bluetooth mouse keeps disconnecting"
    - "my keyboard says paired but doesn't work"
    - "bluetooth stopped working after sleep"
---

## When to use

Use when a Bluetooth peripheral will not connect or keeps dropping. For a wired USB peripheral, use `usb-device-repair` instead.

## Steps

**Step 1 — Read Bluetooth state**

Call `list_bluetooth_devices`.

Note: returns `poweredOn` plus `devices[]` with `connected`, `paired`, `rssi`, and `batteryPercent`.

**Step 2 — Turn the adapter on**

Call `wait_for_user_ack`:

```
prompt: "Bluetooth is switched off. Turn it on in Bluetooth settings, then tell me whether your device works."
options:
  - { id: "works",        label: "It works now",          kind: "primary" }
  - { id: "still-broken", label: "Still not connecting",  kind: "primary" }
  - { id: "cant",         label: "I can't turn it on",    kind: "primary" }
```

`Condition:` only run when Step 1 returned `poweredOn: false`.

**Step 3 — Fix the peripheral**

Call `wait_for_user_ack`:

```
prompt: "Charge the device or replace its batteries, turn it off and on again, and keep it near the computer. If it's a headset, disconnect it from your phone. Then tell me whether it works."
options:
  - { id: "works",        label: "It works now",          kind: "primary" }
  - { id: "still-broken", label: "Still not connecting",  kind: "primary" }
  - { id: "skip",         label: "Can't do this now",     kind: "primary" }
```

`Condition:` only run when either of the following holds:

- Step 2 returned `choice: "still-broken"`.
- Step 1 returned `poweredOn: true` and listed a device that is either `paired: true` with `connected: false`, or has a `batteryPercent` under 20.

**Step 4 — Restart the Bluetooth service**

Call `reset_bluetooth_module`.

`Condition:` only run when Step 3 returned `choice: "still-broken"`.

**Step 5 — Re-read after the restart**

Call `list_bluetooth_devices`.

`Condition:` only run when Step 4 executed.

**Step 6 — Forget and re-pair**

Call `wait_for_user_ack`:

```
prompt: "In Bluetooth settings, forget the device, then put it into pairing mode and pair it again. Tell me whether it works."
options:
  - { id: "works",        label: "It works now",            kind: "primary" }
  - { id: "still-broken", label: "Still not connecting",    kind: "primary" }
  - { id: "skip",         label: "I'll do this later",      kind: "primary" }
```

`Condition:` only run when Step 5 listed a device with `paired: true` and `connected: false`.

**Step 7 — Verify the connection**

Call `list_bluetooth_devices`.

`Condition:` only run when Step 6 returned `choice: "works"` or `choice: "still-broken"`.

Note: success is the device listed with `connected: true`. Still `connected: false` after re-pairing means the peripheral or the adapter is faulty — escalate to hardware replacement.

## Edge cases

- **Device absent from `devices[]`** — it was never paired, so there is no pairing to repair. Report that it needs to be put into pairing mode and paired.
- **`choice: "cant"` in Step 2** — Bluetooth is disabled in firmware, by airplane mode, or by a failed driver. Nothing downstream applies; report and end.
- **Windows returns no `rssi` or `batteryPercent`** — the battery condition in Step 3 never fires there, so range and charge stay unproven. Do not report them as ruled out.
- **Weak `rssi` with the device in the same room** — 2.4 GHz interference, commonly from a USB 3 port or dock beside the receiver. Moving the dock fixes what no software step will.
- **A `choice` that is neither `works` nor `still-broken`** — `skip` and the `timeout`, `cancel`, and `failed` sentinels all leave that remediation unproven and skip every step gated on it. At Step 6 this ends the run with no verification. Do not report the untested cause as ruled out.
