# DriftGuard — Mermaid diagrams

Three diagrams covering the full architecture. Paste any block into a
Mermaid renderer (GitHub markdown, mermaid.live, Notion, Obsidian, etc.).

---

## 1. System overview

Where each piece lives and what data flows between them.

```mermaid
graph TB
    Customer[Customer<br/>browser]
    Dashboard[Dashboard<br/>Next.js<br/><i>public hosting</i>]
    Backend[Backend API<br/>Express + Node<br/><i>private infra</i>]
    Supabase[(Supabase<br/>Postgres<br/><i>install metadata only</i>)]
    LLM[MiniMax<br/>LLM API]
    GitHub[GitHub REST API]
    App[GitHub App<br/>driftguard-dev<br/><i>GitHub-hosted</i>]
    Repo[Customer's<br/>repository]

    Customer -->|HTTPS| Dashboard
    Dashboard -->|JSON over HTTP| Backend
    Backend -->|reads/writes install + repo rows| Supabase
    Backend -->|verdict + fix suggestions| LLM
    Backend -->|mints App JWT<br/>+ exchanges for installation token| App
    App -.->|issues short-lived tokens| Backend
    Backend -->|reads code<br/>creates branches<br/>opens draft PRs| GitHub
    GitHub <--> Repo

    classDef publicHost fill:#1e3a5f,stroke:#4a90e2,color:#fff
    classDef privateHost fill:#3d1e5f,stroke:#9b59b6,color:#fff
    classDef managed fill:#1e5f3d,stroke:#27ae60,color:#fff
    classDef external fill:#5f1e1e,stroke:#e74c3c,color:#fff
    classDef customer fill:#5f4e1e,stroke:#f1c40f,color:#fff

    class Dashboard publicHost
    class Backend privateHost
    class Supabase managed
    class LLM,App,GitHub external
    class Customer,Repo customer
```

---

## 2. Install flow (sequence)

What happens between "Customer clicks Connect GitHub" and "Customer sees
their repo in the dashboard."

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant Dash as Dashboard<br/>(Next.js)
    participant API as Backend<br/>(Express)
    participant DB as Supabase<br/>Postgres
    participant GH as GitHub

    Customer->>Dash: Click "Connect GitHub"
    Dash->>API: GET /api/github/install
    API->>DB: INSERT install_states (state=nonce, expires=now+10m)
    API-->>Dash: 302 → github.com/apps/driftguard-dev/installations/new?state=nonce
    Dash-->>Customer: redirects to GitHub
    Customer->>GH: picks account + repos → clicks Authorize
    GH-->>Customer: 302 → /api/github/callback?installation_id=X&state=nonce
    Customer->>API: GET /api/github/callback
    API->>DB: DELETE install_states WHERE state=nonce AND expires_at > now()<br/>(single-use nonce + replay protection)
    DB-->>API: 0 or 1 row
    alt nonce missing or expired
        API-->>Customer: 400 "Invalid or expired state"
    else nonce valid
        API->>API: mint App-level JWT<br/>(signed with App private key)
        API->>GH: POST /app/installations/X/access_tokens
        GH-->>API: installation token<br/>(1 hour expiry, scoped to authorized repos)
        API->>GH: GET /installation/repositories
        GH-->>API: list of authorized repos
        API->>API: getInstallationAccount<br/>(GET /app/installations/X with App JWT)
        API->>DB: INSERT installations ON CONFLICT UPDATE
        API->>DB: INSERT connected_repos (one per repo) ON CONFLICT UPDATE
        API-->>Customer: 302 → /repositories
        Customer->>Dash: sees success banner + repo list
    end
```

---

## 3. Check pipeline (flow)

The 6-stage engine that runs when a customer clicks **Run a check**.

```mermaid
flowchart LR
    Start([Customer clicks<br/>Run a check]) --> S1
    S1[Stage 1<br/><b>gather</b><br/>npm metadata<br/>+ release notes<br/>+ type diff] --> S2
    S2[Stage 2<br/><b>verdict</b><br/>LLM: is it breaking?<br/>which symbols?] --> Decision1{verdict<br/>.breaking?}
    Decision1 -->|no| Save1[append run to history<br/>no scan, no PR]
    Decision1 -->|yes| S3
    S3[Stage 3<br/><b>scan</b><br/>grep customer repo<br/>for affected symbols] --> Decision2{symbols<br/>with hits?}
    Decision2 -->|no| Save2[append run to history<br/>scan ran, no matches]
    Decision2 -->|yes| S4
    S4[Stage 4<br/><b>fix-draft</b><br/>LLM proposes<br/>one-line fix per match] --> S5
    S5[Stage 5<br/><b>apply + push</b><br/>HIGH confidence only<br/>writes branch<br/>git push] --> S6
    S6[Stage 6<br/><b>open draft PR</b><br/>via installation token] --> Done([draft PR lands<br/>in customer repo])
    Save1 --> End([end])
    Save2 --> End

    classDef stage fill:#1e3a5f,stroke:#4a90e2,color:#fff
    classDef decision fill:#5f4e1e,stroke:#f1c40f,color:#fff
    classDef terminal fill:#1e5f3d,stroke:#27ae60,color:#fff

    class S1,S2,S3,S4,S5,S6 stage
    class Decision1,Decision2 decision
    class Save1,Save2,Done,Start,End terminal
```

---

## 4. Trust boundary diagram

What DriftGuard has access to vs. what it doesn't. Useful for security
review conversations.

```mermaid
graph LR
    subgraph Customer["Customer's GitHub account / org"]
        Repo1[Authorized repo<br/>✅ read + write]
        Repo2[Other private repo<br/>⛔ no access]
        Repo3[Public repo<br/>✅ read-only]
        Settings[Org settings<br/>⛔ no access]
    end

    subgraph DriftGuard["DriftGuard (the App)"]
        InstallToken[Installation token<br/>scoped to Repo1 only]
        Code[Customer code<br/>read in-memory during scan]
        Metadata[(Metadata in our DB<br/>repo names, branches, PR URLs)]
    end

    subgraph LLM["MiniMax LLM API"]
        RedactedSnippets[Redacted call-site<br/>+ suggested fix]
    end

    InstallToken -->|reads + writes| Repo1
    InstallToken -.->|blocked by GitHub| Repo2
    InstallToken -.->|read-only| Repo3
    InstallToken -.->|no permission| Settings

    Code -->|only redacted snippets<br/>leave the backend| RedactedSnippets

    Repo1 --> Metadata

    classDef allowed fill:#1e5f3d,stroke:#27ae60,color:#fff
    classDef blocked fill:#5f1e1e,stroke:#e74c3c,color:#fff
    classDef partial fill:#5f4e1e,stroke:#f1c40f,color:#fff
    classDef internal fill:#1e3a5f,stroke:#4a90e2,color:#fff

    class Repo1 allowed
    class Repo2,Settings blocked
    class Repo3 partial
    class InstallToken,Code,Metadata,RedactedSnippets internal
```

---

## 5. Hosting model

What runs where, and what state lives where.

```mermaid
graph TB
    subgraph PublicInternet["Public internet"]
        Browser[Customer browser]
        CDN[Static CDN / edge<br/>Vercel, Cloudflare, etc.]
    end

    subgraph PrivateInfra["Private infrastructure (VPC / VM)"]
        API[Backend API<br/>Express]
        EnvVars[(Env vars:<br/>GITHUB_APP_PRIVATE_KEY<br/>MINIMAX_API_KEY<br/>SUPABASE_DB_URL)]
        LocalClone[Short-lived<br/>git clone<br/>discarded after scan]
    end

    subgraph GitHubInfra["GitHub infrastructure"]
        AppReg[GitHub App registration<br/>driftguard-dev]
        AppInst[Per-customer installations]
        Repo[Customer repos]
    end

    subgraph ManagedServices["Managed services"]
        Supa[(Supabase<br/>Postgres<br/>us-east-1 / ap-southeast-1)]
        MiniMax[MiniMax LLM API]
    end

    Browser -->|HTTPS| CDN
    CDN -->|static assets| Browser
    Browser -->|API calls| API
    API <-->|reads env at startup| EnvVars
    API -->|on-demand git clone| LocalClone
    LocalClone -.->|rm -rf after scan| API
    API <-->|SQL over TLS| Supa
    API -->|verdict + fix prompt| MiniMax
    MiniMax -->|completion| API
    API -->|mint App JWT<br/>request installation token| AppReg
    AppReg -->|installation token<br/>1h expiry| API
    API -->|reads code<br/>creates branches<br/>opens PRs| AppInst
    AppInst --> Repo

    classDef public fill:#1e3a5f,stroke:#4a90e2,color:#fff
    classDef private fill:#3d1e5f,stroke:#9b59b6,color:#fff
    classDef external fill:#5f1e1e,stroke:#e74c3c,color:#fff
    classDef managed fill:#1e5f3d,stroke:#27ae60,color:#fff

    class Browser,CDN public
    class API,EnvVars,LocalClone private
    class AppReg,AppInst,Repo external
    class Supa,MiniMax managed
```
