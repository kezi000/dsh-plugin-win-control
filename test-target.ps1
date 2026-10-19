Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WinControl UIA Test Target'
$form.Width = 380
$form.Height = 180
$form.StartPosition = 'Manual'
$form.Left = 80
$form.Top = 80
$form.KeyPreview = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'idle'
$label.Name = 'statusLabel'
$label.AutoSize = $true
$label.Left = 16
$label.Top = 12
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'inputBox'
$box.Left = 16
$box.Top = 40
$box.Width = 320
$form.Controls.Add($box)

$button = New-Object System.Windows.Forms.Button
$button.Name = 'goButton'
$button.Text = 'Go'
$button.Left = 16
$button.Top = 74
$button.Width = 90
$button.Add_Click({
  $label.Text = 'clicked:' + $box.Text
})
$form.Controls.Add($button)

$form.Add_KeyDown({
  if ($_.KeyCode -ne [System.Windows.Forms.Keys]::None) {
    $label.Text = 'key:' + $_.KeyCode
  }
})

[System.Windows.Forms.Application]::Run($form)
