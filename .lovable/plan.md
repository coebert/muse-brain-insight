# Polished product shell, admin section and clinician accounts

Three pieces of work: a real role system with you as admin, a clean split between the bedside app and an admin area, and a visual overhaul so the app reads as a finished commercial monitor rather than a workbench.

## 1. Roles and accounts

- Add a roles table (separate from profiles, so a role can never be edited from the browser) with `admin` and `clinician`, plus a server-side check used by every admin page and every admin action.
- Your account is seeded as `admin`.
- New **Admin > People** page: list accounts with their role, invite a new clinician by email (they receive a link and set their own password), change a role, revoke access.
- Anyone signed in without the admin role is a clinician: the admin area is hidden from the menu and blocked server-side if the address is typed directly.
- Sign-up stays closed — accounts exist only by invitation.

## 2. Where each page lives

Clinician (bedside) app — five destinations only:

- **Monitor** (live case), **Cases**, **Patients**, **Notes**, **Settings**.

Admin area at `/admin`, with its own left sidebar and sections:

- **Models** — model versions, COEBIS training data, refit history, engine, calibration, blocked lineages.
- **Validation** — depth dashboard, suppression, flags, agreement report, benchmarks, pathology, compare, replay, trends, brainwaves.
- **Data** — depth corpus intake, reference library, pairing, drug library, drug exposure, ketamine signature, outcomes.
- **Alerts** — alert feedback, alert tuning.
- **People** — accounts and invitations.

Nothing is deleted; every existing page keeps its address and simply moves under the admin gate, and the 28-item Tools dropdown disappears.

## 3. Design overhaul

Direction: theatre dark — near-black chassis (#0B0F14 / #111820), cyan signal accent (#22D3EE), amber and red reserved strictly for caution and critical. Applied as tokens in the stylesheet so every page inherits it.

- **Bedside monitor:** the depth number becomes the dominant object on screen with a large numeral, a colour-coded target band, and its trend directly beneath. Suppression, signal quality and the drug correction sit as compact instrument tiles around it. Everything secondary (explanations, evidence, model detail) moves into a collapsible drawer, so during a case the screen shows the number, the trend, the alarms and the case controls — nothing else.
- **Alarms:** one consistent banner and colour language across the app, with a fixed spot on screen so it never shifts the layout when it fires.
- **Consistent chrome:** one page header component, one panel/card style, one table style, one chart theme (shared axis, grid and tooltip styling) across all pages, replacing the per-page variations that exist now.
- **Typography and density:** tabular figures for every number, a single scale for headings/labels/values, and generous spacing on the bedside screen versus dense tables in admin.
- **Mobile:** the bedside screen stays usable one-handed on a phone (current viewport 440px); the admin area is desktop-first with a collapsible sidebar.
- **Empty and loading states:** proper skeletons and "nothing recorded yet" states instead of blank panels.

## Technical notes

- `user_roles` table + `has_role()` security-definer function; RLS and grants on it; `requireAdmin` server middleware wrapping every admin-only server function (route gates alone are not security).
- Route restructure: `src/routes/_authenticated/admin/*` with a shared `admin/route.tsx` gate; existing route files move, imports updated, nav rebuilt (`AppNav` becomes a slim bedside header plus a separate `AdminSidebar`).
- Design tokens in `src/styles.css` (oklch), new shared `PageHeader`, `Panel`, `DataTable` and chart-theme helpers; no hardcoded colour utilities.
- Invitations via the backend admin API from a server function guarded by `requireAdmin`.
- Existing tests (mobile layout guardrails, panel tests) must keep passing; the depth/suppression logic is untouched.

## Scope

This is layout, navigation, access control and styling only. No change to the depth model, the refit pipeline or any recorded data.
