# ContextDeck Windows helper: a long-lived PowerShell process the plugin talks to over stdin/stdout (one JSON object per line).
# Request:  {"id":1,"op":"front","args":{...}}     Response: {"id":1,"ok":true,"out":...}  or  {"id":1,"ok":false,"error":"..."}
# Started with: powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File win-host.ps1

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CDWin {
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

	public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
	public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

	// Press a chord: mods down, key down/up, mods up (reverse). ext = extended-key flag per vk.
	public static void Chord(byte[] mods, byte key, bool ext) {
		foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
		keybd_event(key, 0, ext ? 1u : 0u, UIntPtr.Zero);
		keybd_event(key, 0, (ext ? 1u : 0u) | 2u, UIntPtr.Zero);
		for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, 2u, UIntPtr.Zero);
	}
}

public static class CDCred {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct CREDENTIAL {
		public int Flags; public int Type; public string TargetName; public string Comment;
		public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
		public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
		public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
	}
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL cred, int flags);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, int type, int flags);
	[DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);

	public static string Get(string target) {
		IntPtr p;
		if (!CredRead(target, 1, 0, out p)) return null;
		try {
			var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
			if (c.CredentialBlobSize == 0) return "";
			return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
		} finally { CredFree(p); }
	}
	public static void Set(string target, string user, string secret) {
		var bytes = Encoding.Unicode.GetBytes(secret);
		var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 2, CredentialBlobSize = bytes.Length, CredentialBlob = Marshal.AllocCoTaskMem(bytes.Length) };
		try {
			Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
			if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
		} finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
	}
	public static void Delete(string target) { CredDelete(target, 1, 0); }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
	int f(); int g(); int h(); int i();
	int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
	int j();
	int GetMasterVolumeLevelScalar(out float pfLevel);
	int k(); int l(); int m(); int n();
	int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
	int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class CDAudio {
	static IAudioEndpointVolume Vol() {
		var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
		IMMDevice dev = null;
		Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
		IAudioEndpointVolume epv = null;
		var id = typeof(IAudioEndpointVolume).GUID;
		Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
		return epv;
	}
	public static float Get() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
	public static void Set(float v) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, Guid.Empty)); }
	public static void ToggleMute() { bool m; var e = Vol(); Marshal.ThrowExceptionForHR(e.GetMute(out m)); Marshal.ThrowExceptionForHR(e.SetMute(!m, Guid.Empty)); }
}
'@

$UIA = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$PropCT = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$SEP = [char]0x1e

function Front {
	$h = [CDWin]::GetForegroundWindow()
	$procId = [CDWin]::Pid($h)
	$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
	$exe = ''; $name = ''; $path = ''
	if ($p) {
		$exe = "$($p.ProcessName).exe"
		try { $path = $p.MainModule.FileName } catch {}
		try { $name = $p.MainModule.FileVersionInfo.FileDescription } catch {}
		if (-not $name) { $name = $p.ProcessName }
	}
	@{ appId = $exe.ToLower(); app = $name; title = [CDWin]::Title($h); pid = $procId; path = $path }
}

function BrowserTab {
	$h = [CDWin]::GetForegroundWindow()
	$title = [CDWin]::Title($h)
	$url = ''
	try {
		$root = $UIA::FromHandle($h)
		$edits = $root.FindAll($TreeScope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::Edit)))
		foreach ($e in $edits) {
			$n = $e.Current.Name
			if ($n -match 'Address|address|URL|Search or enter|Adresse|search bar') {
				$vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
				$url = $vp.Current.Value
				break
			}
		}
	} catch {}
	@{ url = $url; title = $title }
}

function WindowText {
	$h = [CDWin]::GetForegroundWindow()
	$root = $UIA::FromHandle($h)
	$texts = $root.FindAll($TreeScope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::Text)))
	($texts | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join "`n"
}

function Expand($el) {
	try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); Start-Sleep -Milliseconds 120 } catch {}
}
function Collapse($el) {
	try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}
}

# Classic menu bar via UI Automation: "Top<SEP>Item<TAB>Ctrl+N" lines. Apps without a menu bar return nothing.
function Menus {
	$h = [CDWin]::GetForegroundWindow()
	$root = $UIA::FromHandle($h)
	$bar = $root.FindFirst($TreeScope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::MenuBar)))
	if (-not $bar) { return '' }
	$lines = New-Object System.Collections.Generic.List[string]
	$tops = $bar.FindAll($TreeScope::Children, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::MenuItem)))
	foreach ($top in $tops) {
		$topName = $top.Current.Name
		if ($topName -match '^(System|Help|Hilfe|Aide)$') { continue }
		Expand $top
		$menu = $UIA::RootElement.FindFirst($TreeScope::Children, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::Menu)))
		$scope = if ($menu) { $menu } else { $top }
		$items = $scope.FindAll($TreeScope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::MenuItem)))
		foreach ($it in $items) {
			$n = $it.Current.Name
			if (-not $n) { continue }
			$acc = $it.Current.AcceleratorKey
			if (-not $acc -and $n -match "`t(.+)$") { $acc = $Matches[1]; $n = $n -replace "`t.+$", '' }
			$lines.Add("$topName$SEP$n`t$acc`t$($it.Current.IsEnabled.ToString().ToLower())")
		}
		Collapse $top
		[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
	}
	$lines -join "`n"
}

function ClickMenu($path) {
	$h = [CDWin]::GetForegroundWindow()
	$root = $UIA::FromHandle($h)
	$bar = $root.FindFirst($TreeScope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::MenuBar)))
	if (-not $bar) { throw 'This app has no menu bar' }
	$scope = $bar
	for ($i = 0; $i -lt $path.Count; $i++) {
		$cond = New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition($PropCT, $CT::MenuItem)), (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $path[$i])))
		$el = $scope.FindFirst($TreeScope::Descendants, $cond)
		if (-not $el) { $el = $UIA::RootElement.FindFirst($TreeScope::Descendants, $cond) }
		if (-not $el) { throw "Menu item not found: $($path[$i])" }
		if ($i -lt $path.Count - 1) { Expand $el; $scope = $UIA::RootElement }
		else { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
	}
}

function Prompt($title, $message) {
	$f = New-Object System.Windows.Forms.Form
	$f.Text = $title; $f.Width = 460; $f.Height = 220; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false
	$l = New-Object System.Windows.Forms.Label; $l.Text = $message; $l.Left = 12; $l.Top = 10; $l.Width = 420; $l.Height = 80
	$t = New-Object System.Windows.Forms.TextBox; $t.Left = 12; $t.Top = 96; $t.Width = 420; $t.UseSystemPasswordChar = $true
	$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Save'; $ok.Left = 272; $ok.Top = 132; $ok.DialogResult = 'OK'
	$cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.Left = 356; $cancel.Top = 132; $cancel.DialogResult = 'Cancel'
	$f.Controls.AddRange(@($l, $t, $ok, $cancel)); $f.AcceptButton = $ok; $f.CancelButton = $cancel
	if ($f.ShowDialog() -eq 'OK') { return $t.Text } else { return $null }
}

function Notify($title, $text) {
	[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
	$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
	$nodes = $tpl.GetElementsByTagName('text')
	$nodes.Item(0).AppendChild($tpl.CreateTextNode($title)) | Out-Null
	$nodes.Item(1).AppendChild($tpl.CreateTextNode($text)) | Out-Null
	$toast = New-Object Windows.UI.Notifications.ToastNotification $tpl
	[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
}

function TypeText($text) {
	$escaped = ($text -replace '([+^%~(){}\[\]])', '{$1}') -replace "`r?`n", '{ENTER}'
	[System.Windows.Forms.SendKeys]::SendWait($escaped)
}

function AppVersion($appId) {
	$name = $appId -replace '\.exe$', ''
	$p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
	if (-not $p) { return '' }
	try { return $p.MainModule.FileVersionInfo.ProductVersion } catch { return '' }
}

function Facts {
	$os = Get-CimInstance Win32_OperatingSystem
	@{
		os = "$($os.Caption) ($($os.BuildNumber))"
		arch = $env:PROCESSOR_ARCHITECTURE
		keyboard = [System.Windows.Forms.InputLanguage]::CurrentInputLanguage.LayoutName
		locale = (Get-Culture).Name
	}
}

function Handle($req) {
	$a = $req.args
	switch ($req.op) {
		'ping' { 'pong' }
		'front' { Front }
		'tab' { BrowserTab }
		'title' { [CDWin]::Title([CDWin]::GetForegroundWindow()) }
		'wintext' { WindowText }
		'chords' { foreach ($c in $a.chords) { [CDWin]::Chord([byte[]]@($c.mods), [byte]$c.key, [bool]$c.ext); Start-Sleep -Milliseconds 40 } ; 'ok' }
		'type' { TypeText $a.text; 'ok' }
		'clipget' { $v = Get-Clipboard -Raw; if ($null -eq $v) { '' } else { $v } }
		'clipset' { Set-Clipboard -Value $a.text; 'ok' }
		'notify' { Notify $a.title $a.text; 'ok' }
		'prompt' { Prompt $a.title $a.message }
		'volget' { [math]::Round([CDAudio]::Get() * 100) }
		'volset' { [CDAudio]::Set([float]($a.value / 100)); 'ok' }
		'mute' { [CDAudio]::ToggleMute(); 'ok' }
		'secretget' { [CDCred]::Get("contextdeck:$($a.account)") }
		'secretset' { [CDCred]::Set("contextdeck:$($a.account)", $a.account, $a.value); 'ok' }
		'secretdel' { [CDCred]::Delete("contextdeck:$($a.account)"); 'ok' }
		'menus' { Menus }
		'click' { ClickMenu $a.path; 'ok' }
		'version' { AppVersion $a.appId }
		'facts' { Facts }
		'script' { (Invoke-Expression $a.script | Out-String).Trim() }
		default { throw "unknown op $($req.op)" }
	}
}

while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line) { break }
	if (-not $line.Trim()) { continue }
	$id = $null
	try {
		$req = $line | ConvertFrom-Json
		$id = $req.id
		$out = Handle $req
		[Console]::Out.WriteLine((@{ id = $id; ok = $true; out = $out } | ConvertTo-Json -Compress -Depth 6))
	} catch {
		[Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 3))
	}
	[Console]::Out.Flush()
}
