# Security Policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that includes credentials,
private messages, personal data, a working exploit, or enough detail to
reproduce an attack against a deployed instance.

If the repository is hosted on GitHub, use its private vulnerability reporting
channel. If that is unavailable, contact the maintainer through the private
contact method published on the hosting profile. Include:

- affected version or commit;
- deployment shape (local development, standalone server, QQ/NapCat);
- minimal reproduction steps;
- impact and any suggested mitigation;
- whether any real credential or personal record was exposed.

Never send real API keys, QQ credentials, SSH private keys, cookies, or chat
transcripts. Replace them with clearly fake test values.

## Supported versions

Security fixes target the current `main` branch. Historical tags are kept for
recovery and research, but are not supported deployment targets.

## Operational boundary

Kanobot is designed for a single trusted owner on a local or otherwise
access-controlled machine. Binding it to a public interface without TLS,
external authentication, network filtering, and an independent security review
is outside the supported configuration.

The local secret store protects values at rest against casual file inspection.
It does not defend against an attacker who already has the same operating-system
account and can read both the key and the encrypted store.

QQ/NapCat integration is an external, unsupported platform dependency. Account
restrictions and platform-rule risk are not security guarantees supplied by
Kanobot.
