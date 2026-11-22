# Canvas LMS launch from EduOS

EduOS launches Canvas as an approved app-catalog destination. Canvas is not the LTI platform in this direction: EduOS does not send an LTI platform launch to Canvas. The existing app launcher records the launch, enforces district app assignment and license/seat rules, and returns the configured Canvas URL.

## Recommended registration

A superintendent or IT administrator registers the district's own Canvas instance in **Apps**:

- **Name:** Canvas LMS
- **Vendor:** Instructure
- **Launch URL:** the district's HTTPS Canvas base URL, for example `https://district.instructure.com/`. Use the district's actual Canvas host; do not use a generic vendor URL or another district's tenant.
- **Integration type:** `oidc_sso` if the district has configured Canvas to federate with the district identity provider; otherwise `link`.
- **Data sharing scope:** choose the minimum truthful scope. Use `identity` only when the district identity provider will release identity claims to Canvas and that sharing has been approved. Do not claim `none` if the district IdP sends identity attributes.
- **DPA / FERPA / COPPA settings:** set only after the district has completed its own vendor, contract, privacy, and learner-eligibility review. These flags are governance declarations, not automatic Canvas certifications.
- **License and assignment:** add the district's approved license and assign Canvas only to the schools, grade levels, and roles authorized by district policy.

The app's integration configuration must not contain Canvas passwords, API tokens, OAuth client secrets, or private keys. The generic app launch returns the configured destination URL; it does not mint Canvas sessions or exchange Canvas OAuth tokens.

## Single sign-on

For a seamless sign-in, the district must configure Canvas authentication to use the same district-managed identity provider that users use for EduOS (for example, the district's OIDC or SAML identity provider). EduOS does not pass its session cookie or password to Canvas. Whether the user reaches Canvas without another sign-in prompt depends on the identity provider's existing browser session and the district's Canvas authentication configuration.

If Canvas is not federated with the district identity provider, choose `link`; users will sign in to Canvas using the district's configured Canvas sign-in method.

## What this launch does not provide

- It does not provide Canvas API access, roster synchronization, course synchronization, or grade exchange.
- It does not configure Canvas developer keys or OAuth authorization.
- It does not create or impersonate Canvas users.
- It does not guarantee silent SSO; that depends on the district IdP and Canvas configuration.

Canvas API access is a separate connector project. Canvas documents its OAuth 2.0 authorization-code flow and institution-managed, scope-limited developer keys. Any future API connector must use per-user or explicitly authorized district credentials, encrypted token storage, exact redirect-URI/state validation, tenant isolation, minimum API scopes, and audit logging. It must not reuse a learner's browser session or ask users to paste personal access tokens.

## Verification

The app-launch integration test registers a Canvas destination as an `oidc_sso` app, assigns it to a district, and verifies that an eligible learner receives the exact district Canvas URL from the launch endpoint. Production acceptance additionally requires a district Canvas test tenant, real IdP federation testing, privacy/accessibility review, and confirmation of the district's allowed roles and grades.
