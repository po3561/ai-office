$ErrorActionPreference = 'Stop'
# Shows the Windows folder picker on the signed-in user's desktop and prints the
# chosen path as base64 UTF-8 (empty output when cancelled).
try {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = 'CenterScreen'
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $owner.Show()
  $owner.Activate()
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'LAPIS 파일 서버로 공유할 폴더를 선택하세요. 드라이브 전체는 선택할 수 없습니다.'
  $dialog.ShowNewFolderButton = $false
  $result = $dialog.ShowDialog($owner)
  $owner.Close()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
