<#
.SYNOPSIS
  Lock down `main`: only the owner pushes directly, everyone else goes through a
  reviewed pull request.

.DESCRIPTION
  Kept as a script rather than done by hand in the web UI so the rules are
  reviewable, repeatable, and recorded in the repo they apply to.

  GitHub gates branch protection on plan and visibility: on a *private*
  repository under a free account, both the branch-protection API and the newer
  rulesets API return 403 "Upgrade to GitHub Pro or make this repository
  public". There is no way around that from the API, so this script checks
  visibility first and says so plainly instead of failing with GitHub's message.

  A ruleset rather than classic branch protection, because rulesets are the
  direction GitHub is moving and they express bypass more precisely - the owner
  keeps the ability to push directly, which is what was asked for, while a
  contributor's only route to `main` is a PR the owner approves.

  Requires the gh CLI, authenticated with `repo` scope.

.PARAMETER Repo
  owner/name. Defaults to this project.

.PARAMETER RequireCi
  Also require the CI workflow to pass before a PR can merge. Off by default
  because it will block merges until CI has run successfully at least once and
  GitHub knows the check's name.

.PARAMETER Proxy
  HTTPS proxy for the gh calls. Defaults to Intel's, which is required on a
  corporate machine; pass an empty string to run without one.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\protect-main.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\protect-main.ps1 -RequireCi
#>

[CmdletBinding()]
param(
  [string]$Repo = 'AndreiElekesIntel/claude-lifeline',
  [switch]$RequireCi,
  [string]$Proxy = 'http://proxy-dmz.intel.com:912'
)

$ErrorActionPreference = 'Stop'

function Ok   ($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Note ($m) { Write-Host "       $m" -ForegroundColor DarkGray }
function Bad  ($m) { Write-Host "  FAIL $m" -ForegroundColor Red }

if ($Proxy) { $env:HTTPS_PROXY = $Proxy }

Write-Host ''
Write-Host "  Protecting main on $Repo" -ForegroundColor White
Write-Host ''

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Bad 'The gh CLI was not found on PATH. Install it from https://cli.github.com'
  exit 1
}

# Visibility first: the 403 GitHub returns for a private repo names a billing
# plan and not the actual blocker, which sends you looking in the wrong place.
$visibility = (gh api "repos/$Repo" --jq '.visibility')
if ($LASTEXITCODE -ne 0) {
  Bad "Could not read $Repo. Check `gh auth status`."
  exit 1
}
Note "Repository is $visibility."

if ($visibility -ne 'public') {
  Write-Host ''
  Bad 'Branch protection needs a public repository (or a paid plan).'
  Note 'GitHub refuses both the branch-protection and the rulesets API on a'
  Note 'private repo under a free account. Nothing here can work around that.'
  Write-Host ''
  Note 'To publish and protect in one go:'
  Write-Host "    gh repo edit $Repo --visibility public --accept-visibility-change-consequences" -ForegroundColor Cyan
  Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\protect-main.ps1" -ForegroundColor Cyan
  Write-Host ''
  Note 'Publishing makes every commit and all release history world-readable.'
  Note 'Worth a look through the log first if anything internal ever landed in it.'
  Write-Host ''
  exit 2
}

# Owner keeps direct push; everyone else goes through review. Role id 5 is
# "admin" in GitHub's ruleset actor vocabulary.
$rules = @(
  @{ type = 'deletion' }
  @{ type = 'non_fast_forward' }
  @{
    type = 'pull_request'
    parameters = @{
      required_approving_review_count   = 1
      dismiss_stale_reviews_on_push     = $true
      require_code_owner_review         = $true
      require_last_push_approval        = $false
      required_review_thread_resolution = $true
    }
  }
)

if ($RequireCi) {
  $rules += @{
    type = 'required_status_checks'
    parameters = @{
      strict_required_status_checks_policy = $true
      required_status_checks = @( @{ context = 'test' } )
    }
  }
}

$ruleset = @{
  name        = 'Protect main'
  target      = 'branch'
  enforcement = 'active'
  conditions  = @{ ref_name = @{ include = @('refs/heads/main'); exclude = @() } }
  rules       = $rules
  bypass_actors = @(
    @{ actor_id = 5; actor_type = 'RepositoryRole'; bypass_mode = 'always' }
  )
}

# Idempotent: replace an existing ruleset of the same name rather than stacking
# a second copy of the same rules on top of it.
$existing = (gh api "repos/$Repo/rulesets" --jq '.[] | select(.name == "Protect main") | .id') 2>$null
$json = $ruleset | ConvertTo-Json -Depth 10

if ($existing) {
  Note "Updating existing ruleset $existing."
  $json | gh api -X PUT "repos/$Repo/rulesets/$existing" --input - | Out-Null
} else {
  $json | gh api -X POST "repos/$Repo/rulesets" --input - | Out-Null
}

if ($LASTEXITCODE -ne 0) { Bad 'GitHub rejected the ruleset. See the message above.'; exit 1 }

Ok 'main now requires a pull request with one approving review'
Ok 'Reviews are dismissed when a PR is pushed to'
Ok 'Code owner review required (see .github/CODEOWNERS)'
Ok 'Conversations must be resolved before merge'
Ok 'Force pushes and branch deletion blocked'
if ($RequireCi) { Ok 'CI must pass before merge' }
Ok 'Repository admin can still push directly'

# Squash-only keeps the history on main readable: one commit per reviewed
# change, rather than a contributor's work-in-progress commits.
gh api -X PATCH "repos/$Repo" -F allow_squash_merge=true -F allow_merge_commit=false `
  -F allow_rebase_merge=false -F delete_branch_on_merge=true -F allow_auto_merge=true | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'Squash-only merges, branches deleted after merge' }

Write-Host ''
Note "Review at https://github.com/$Repo/settings/rules"
Write-Host ''
