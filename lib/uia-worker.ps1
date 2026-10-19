# uia-worker.ps1 — long-lived UI Automation helper for dsh-plugin-win-control.
# Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
# The process is started once and kept warm so a UIA round trip costs ~10-40 ms
# instead of the ~250 ms PowerShell startup that a per-call spawn would pay.
#
# Read-only by default. Mutating commands (invoke / setvalue / selectitem) only use
# UI Automation patterns, which never move the mouse or steal keyboard focus.

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; fatal = "Cannot load UIAutomationClient: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
  exit 1
}

$script:utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $script:utf8
[Console]::InputEncoding = $script:utf8

$script:TrueCondition = [System.Windows.Automation.Condition]::TrueCondition
$script:ControlWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Write-Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 12))
  [Console]::Out.Flush()
}

function Get-Rect($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { return $null }
    return @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch { return $null }
}

function Get-ElementByHandle($hwnd) {
  $h = [IntPtr]::new([Int64]$hwnd)
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

function Get-NodeInfo($el, $depth, $path) {
  $c = $el.Current
  $patterns = @()
  try {
    foreach ($p in $el.GetSupportedPatterns()) {
      $patterns += $p.ProgrammaticName -replace 'PatternIdentifiers.Pattern$', ''
    }
  } catch { }
  # Legacy MSAA proxies (plain Win32 / WinForms controls) expose no modern pattern
  # list entry, but they still answer through LegacyIAccessiblePattern.
  if ($patterns -notcontains 'LegacyIAccessible') {
    try {
      [void]$el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $patterns += 'LegacyIAccessible'
    } catch { }
  }
  return [ordered]@{
    id            = -1
    depth         = $depth
    path          = @($path)
    name          = [string]$c.Name
    controlType   = ([string]$c.ControlType.ProgrammaticName) -replace 'ControlType.', ''
    automationId  = [string]$c.AutomationId
    className     = [string]$c.ClassName
    enabled       = [bool]$c.IsEnabled
    offscreen     = [bool]$c.IsOffscreen
    focusable     = [bool]$c.IsKeyboardFocusable
    focused       = [bool]$c.HasKeyboardFocus
    rect          = Get-Rect $el
    patterns      = $patterns
  }
}

# Breadth-first walk keeps short paths short and lets maxNodes cut a huge tree fairly.
function Get-Tree($root, $maxDepth, $maxNodes, $includeOffscreen) {
  $list = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ el = $root; depth = 0; path = @() })
  while ($queue.Count -gt 0) {
    if ($list.Count -ge $maxNodes) { break }
    $item = $queue.Dequeue()
    $node = Get-NodeInfo $item.el $item.depth $item.path
    if ((-not $includeOffscreen) -and $node.offscreen) { continue }
    $node.id = $list.Count
    [void]$list.Add($node)
    if ($item.depth -ge $maxDepth) { continue }
    try {
      $child = $script:ControlWalker.GetFirstChild($item.el)
      $i = 0
      while ($null -ne $child) {
        $queue.Enqueue(@{ el = $child; depth = $item.depth + 1; path = @($item.path + $i) })
        $child = $script:ControlWalker.GetNextSibling($child)
        $i++
      }
    } catch { }
  }
  return $list
}

# Resolve a child-index path (as reported by "tree") to a live element.
function Resolve-Path($root, $path) {
  $el = $root
  foreach ($index in $path) {
    $child = $script:ControlWalker.GetFirstChild($el)
    $i = 0
    $found = $null
    while ($null -ne $child) {
      if ($i -eq [int]$index) { $found = $child; break }
      $child = $script:ControlWalker.GetNextSibling($child)
      $i++
    }
    if ($null -eq $found) { throw "path segment $index not found" }
    $el = $found
  }
  return $el
}

function Find-Elements($root, $req) {
  if ($null -ne $req.path) { return @(Resolve-Path $root ([int[]]$req.path)) }
  $conditions = New-Object System.Collections.ArrayList
  if ($req.name) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$req.name)))
  }
  if ($req.automationId) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$req.automationId)))
  }
  if ($req.className) {
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$req.className)))
  }
  if ($req.controlType) {
    $ct = $null
    foreach ($f in [System.Windows.Automation.ControlType].GetFields()) {
      if ($f.Name -eq [string]$req.controlType) { $ct = $f.GetValue($null) }
    }
    if ($null -eq $ct) { throw "unknown controlType: $($req.controlType)" }
    [void]$conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)))
  }
  if ($conditions.Count -eq 0) { throw 'select needs a path, name, automationId, className or controlType' }
  $condition = $conditions[0]
  for ($i = 1; $i -lt $conditions.Count; $i++) {
    $condition = New-Object System.Windows.Automation.AndCondition($condition, $conditions[$i])
  }
  $scope = if ($req.shallow) { [System.Windows.Automation.TreeScope]::Children } else { [System.Windows.Automation.TreeScope]::Descendants }
  $matches = $root.FindAll($scope, $condition)
  if ($matches.Count -eq 0) { throw 'no element matched the selector' }
  return @($matches)
}

function Find-Element($root, $req) {
  $matches = @(Find-Elements $root $req)
  if ($matches.Count -eq 0) { throw 'no element matched the selector' }
  $index = 0
  if ($null -ne $req.index) { $index = [int]$req.index }
  if ($index -ge $matches.Count) { throw "index $index out of range ($($matches.Count) matches)" }
  return $matches[$index]
}

function Invoke-Element($el) {
  $used = @()
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    $used += 'InvokePattern'
    return @{ ok = $true; method = $used }
  } catch { }
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    $used += 'SelectionItemPattern'
    return @{ ok = $true; method = $used }
  } catch { }
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $pattern.Toggle()
    $used += 'TogglePattern'
    return @{ ok = $true; method = $used }
  } catch { }
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $pattern.DoDefaultAction()
    $used += 'LegacyIAccessiblePattern'
    return @{ ok = $true; method = $used }
  } catch { }
  return @{ ok = $false; method = $used; reason = 'element exposes no Invoke/SelectionItem/Toggle/LegacyIAccessible pattern; it needs synthetic input, which this plugin does not do by default' }
}

function Set-ElementValue($el, $value) {
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern.Current.IsReadOnly) { return @{ ok = $false; reason = 'element value is read-only' } }
    $pattern.SetValue([string]$value)
    return @{ ok = $true; method = @('ValuePattern') }
  } catch { }
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $pattern.SetValue([string]$value)
    return @{ ok = $true; method = @('LegacyIAccessiblePattern') }
  } catch {
    return @{ ok = $false; reason = "neither ValuePattern nor LegacyIAccessiblePattern accepted a value: $($_.Exception.Message)" }
  }
}

Write-Reply @{ ok = $true; ready = $true; version = '0.1.0' }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
  } catch {
    Write-Reply @{ ok = $false; error = 'invalid JSON request' }
    continue
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    switch ([string]$req.cmd) {
      'ping' {
        Write-Reply @{ ok = $true; pong = $true; elapsedMs = $sw.Elapsed.TotalMilliseconds }
      }
      'tree' {
        $root = Get-ElementByHandle $req.hwnd
        if ($null -eq $root) { throw "window not found: $($req.hwnd)" }
        $maxDepth = 8; if ($null -ne $req.maxDepth) { $maxDepth = [int]$req.maxDepth }
        $maxNodes = 400; if ($null -ne $req.maxNodes) { $maxNodes = [int]$req.maxNodes }
        $includeOffscreen = $false; if ($null -ne $req.includeOffscreen) { $includeOffscreen = [bool]$req.includeOffscreen }
        $nodes = Get-Tree $root $maxDepth $maxNodes $includeOffscreen
        Write-Reply @{ ok = $true; nodes = $nodes; count = $nodes.Count; root = (Get-NodeInfo $root 0 @()); elapsedMs = $sw.Elapsed.TotalMilliseconds }
      }
      'find' {
        $root = Get-ElementByHandle $req.hwnd
        if ($null -eq $root) { throw "window not found: $($req.hwnd)" }
        $matches = @(Find-Elements $root $req)
        $limit = 20; if ($null -ne $req.limit) { $limit = [int]$req.limit }
        $nodes = @()
        $i = 0
        foreach ($el in $matches) {
          if ($i -ge $limit) { break }
          $nodes += (Get-NodeInfo $el 0 @())
          $i++
        }
        Write-Reply @{ ok = $true; total = $matches.Count; nodes = $nodes; elapsedMs = $sw.Elapsed.TotalMilliseconds }
      }
      'inspect' {
        $root = Get-ElementByHandle $req.hwnd
        if ($null -eq $root) { throw "window not found: $($req.hwnd)" }
        $el = Find-Element $root $req
        Write-Reply @{ ok = $true; node = (Get-NodeInfo $el 0 @()); elapsedMs = $sw.Elapsed.TotalMilliseconds }
      }
      'invoke' {
        $root = Get-ElementByHandle $req.hwnd
        if ($null -eq $root) { throw "window not found: $($req.hwnd)" }
        $el = Find-Element $root $req
        $result = Invoke-Element $el
        $result.elapsedMs = $sw.Elapsed.TotalMilliseconds
        $result.node = Get-NodeInfo $el 0 @()
        Write-Reply $result
      }
      'setvalue' {
        $root = Get-ElementByHandle $req.hwnd
        if ($null -eq $root) { throw "window not found: $($req.hwnd)" }
        $el = Find-Element $root $req
        $result = Set-ElementValue $el ([string]$req.value)
        $result.elapsedMs = $sw.Elapsed.TotalMilliseconds
        $result.node = Get-NodeInfo $el 0 @()
        Write-Reply $result
      }
      default {
        Write-Reply @{ ok = $false; error = "unknown cmd: $($req.cmd)" }
      }
    }
  } catch {
    Write-Reply @{ ok = $false; error = $_.Exception.Message; elapsedMs = $sw.Elapsed.TotalMilliseconds }
  }
}
