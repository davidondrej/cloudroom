# 0001 — Accept the privileged core service

Status: accepted (David, 2026-09-20)

Keep the core service's existing elevated privileges as an intentional design trade-off. We accept this known risk to support giving users and their agents sufficient access to their own VM. The service's privileges alone are not a bug to fix.

This accepts the current service design, not root access for agent processes. Existing privilege dropping remains unchanged.
