<div align="center">
  <img src="assets/logo.png" width="200" alt="Gitybara Logo">
  <br>
  <h2>An AI coding assistant that actually ships code.</h2>
  <p><b>Stop prompting. Start delegating.</b></p>
  
  <p>
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
    <img src="https://img.shields.io/badge/Maintained-yes-blue.svg" alt="Maintained">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
    <img src="https://img.shields.io/badge/Engine-OpenCode-orange.svg" alt="OpenCode">
  </p>

  <p>
    <b>Gitybara is an autonomous AI developer built on top of OpenCode.</b><br>
    Most AI tools help you write code. Gitybara actually does the development.<br>
    It turns issues into branches, code, and pull requests — automatically.<br>
    <i>Instead of chatting with AI, you assign it work.</i>
  </p>
</div>

---

## 🚀 What Gitybara Does

Gitybara transforms your GitHub workflow into an AI-driven development system.

1. You create an issue (or send a message via WhatsApp / Telegram).
2. Gitybara reads the task.
3. It selects the right AI model using labels.
4. It creates a branch.
5. It implements the solution using OpenCode.
6. It opens a pull request.
7. You review and merge.

That’s it.

No copy-paste.
No terminal juggling.
No AI chat babysitting.

---

## 🧠 Why It’s Different

Most AI coding assistants are:
- Chat-based
- Interactive
- Suggestion-driven
- Synchronous

Gitybara is:
- Issue-driven
- Autonomous
- Workflow-native
- Asynchronous
- Outcome-focused (PR ready)

It doesn’t assist.
It executes.

---

## ⚙ Core Capabilities

- 🔁 **Issue → PR Automation**  
  Fully automated development from GitHub issues.

- 🏷 **Model Control via Labels**  
  Choose AI behavior directly from GitHub using labels.

- 🌿 **Git-Native Execution**  
  Creates branches, commits changes, and opens PRs automatically.

- 📱 **Messaging to Code**  
  Send ideas via WhatsApp or Telegram — Gitybara converts them into issues and executes.

- 🔄 **Feedback Loop**  
  Request changes in the PR. Gitybara updates the branch automatically.

---

### 🛠 Installation & Setup

```bash
bun install gitybara -g

# Install Chrome for WhatsApp bridge
npx puppeteer browsers install chrome
```

Alternatively (Dev):
```bash
git clone https://github.com/your-username/gitybara.git
cd gitybara
npm install
npm run build
npm link
````

### Prerequisites

* OpenCode installed and available in PATH
* GitHub Personal Access Token (`repo`, `workflow`)
* Git 2.30+ (worktree support)
* **Chrome/Chromium** (Required for WhatsApp integration. Install via `npx puppeteer browsers install chrome`)

---

## 🚦 Getting Started

### 1️⃣ Initialize
Launch the onboarding wizard to connect your GitHub account and select repositories using a searchable interface.

```bash
gitybara init
```

*Note: You can also use `gitybara add` later to connect more repositories individually.*

### 2️⃣ Start the Agent

```bash
gitybara start
```

Gitybara now listens for issues labeled `gitybara` and executes them automatically.

---

## 📱 Mobile Workflow

Text Gitybara:

> “Add JWT authentication to the API”

It:

* Creates a GitHub issue
* Confirms the task
* Starts development
* Sends you the PR link when ready

You review.
You merge.
Done.

---

## 📐 Architecture

<div align="center">
  <img src="assets/architecture.png" alt="Gitybara Architecture">
</div>

Gitybara acts as the **Orchestrator** between:

* GitHub
* Messaging platforms
* OpenCode runtime Agent
* Your repository

It coordinates.
OpenCode executes.
GitHub becomes the control panel.

---

## 📊 CLI Commands

| Command           | Description                        |
| ----------------- | ---------------------------------- |
| `gitybara init`   | Connect repositories (Searchable)  |
| `gitybara add`    | Add a new repository (Searchable)   |
| `gitybara rm`     | Remove a repository                |
| `gitybara start`  | Start background agent             |
| `gitybara stop`   | Stop agent                         |
| `gitybara status` | View active jobs                   |
| `gitybara config` | Configure tokens & settings        |
| `gitybara repo`   | List all connected repositories    |

---

## 💬 PR Comment Automation

Gitybara automatically detects and responds to actionable comments on Pull Requests. This enables continuous development based on code review feedback.

### How It Works

When you or reviewers leave comments on PRs, Gitybara:
1. Monitors PR comments in real-time
2. Detects actionable keywords and patterns
3. Automatically implements the requested changes
4. Pushes updates back to the PR branch
5. Posts a response summarizing the changes

### Trigger Keywords

Gitybara recognizes the following keywords and phrases in PR comments:

**Direct Action Keywords:**
- `fix`, `change`, `update`, `modify`, `correct`, `improve`
- `please fix`, `can you fix`, `need to fix`, `should fix`
- `change request`, `requested changes`, `please address`
- `update the`, `modify the`, `fix the`, `correct the`

**Future Fix Indicators:**
- `TODO`, `FIXME`, `future fix`, `future improvement`
- `later fix`, `fix later`, `address later`
- `fix in next iteration`, `needs work`, `needs fixing`
- `should be fixed`, `must fix`, `temporary fix`
- `temporary solution`, `hack`, `workaround`

### Comment Best Practices

**Effective Comments:**
```markdown
TODO: Add input validation for the email field

FIXME: The error handling here should catch specific exceptions

Please fix the indentation in this function

Can you update the README to document this new feature?
```

**Comments with Code Suggestions:**
```markdown
Please change this to use async/await:

```typescript
const result = await fetchData();
```

Fix the typo in the variable name: `recieve` should be `receive`
```

**Nitpick Comments:**
```markdown
nit: Consider using a constant here instead of magic number

nitpick: The function name could be more descriptive
```

### What Gitybara Ignores

- Bot comments (from CI tools, etc.)
- Gitybara's own comments (to avoid loops)
- Comments without actionable keywords
- Very short comments (< 50 characters without keywords)

### Response Confidence

Gitybara assigns a confidence score to each detected action:
- **High (70%+):** Direct fix requests with code suggestions
- **Medium (40-70%):** General fix/improvement requests
- **Low (30-40%):** Questions or substantial feedback without clear action

Only comments with confidence ≥ 30% are processed automatically.

### Disabling Comment Processing

To temporarily disable automatic comment processing on a PR, add the label `gitybara:pause` to the PR.

---

<div align="center">
  <sub>Autonomous development inside GitHub.</sub>
  <br>
  <sub><b>From issue to PR — automatically.</b></sub>
</div>
