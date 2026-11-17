# External AI provider egress policy

External AI is disabled unless both `AI_PROVIDER=openai_compatible` and
`AI_ALLOW_EXTERNAL_PROVIDER=true` are explicitly set.

When enabling it, configure an explicit host allowlist:

```env
AI_PROVIDER=openai_compatible
AI_ALLOW_EXTERNAL_PROVIDER=true
AI_PROVIDER_URL=https://api.vendor.example/v1
AI_PROVIDER_ALLOWED_HOSTS=api.vendor.example
AI_PROVIDER_MODEL=your-approved-model
AI_PROVIDER_API_KEY=...
```

`AI_PROVIDER_ALLOWED_HOSTS` accepts comma-separated exact hostnames or parent
domains. A parent domain also permits its subdomains. It is required whenever
external AI is enabled. Use the narrowest possible hostname, not a broad
shared hosting domain.

At runtime EduOS validates the HTTPS URL and allowlist, resolves all DNS
answers, rejects the request if any answer is non-public or special-purpose,
and connects to the vetted address while retaining TLS hostname verification.
Redirects are not followed. DNS failures and blocked destinations fail closed
to the local provider. Provider responses are limited to 1 MiB and request
timeouts remain bounded.

The existing redaction step still runs before external provider serialization.
Pattern-based redaction is not guaranteed anonymization: districts must
separately approve the provider, contract, retention/training terms, and the
data categories allowed to leave the district. Keep sensitive workflows local.

This policy covers the staff AI gateway in `src/ai/providers.js`. It does not
automatically authorize or configure other AI integrations such as Christie.
