$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $directory = Get-Item -LiteralPath $inputData.path -Force
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid directory' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($identity in @($sid, $systemSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $directory.SetAccessControl($acl)
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
