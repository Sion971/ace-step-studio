# ACE-Step Studio - raccourcis Windows (Bureau et menu Demarrer), avec l'icone app\docs\Ace-Step UI.ico.
# Appele par create-shortcut.bat (lui-meme appele par install.bat). Peut etre relance a tout moment : il remplace ses
# propres raccourcis sans rien dupliquer. Si le dossier du Studio est deplace, le relancer.
param(
    [switch]$NoDesktop,
    [switch]$NoMenu,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'run.bat'
$icon = Join-Path $root 'app\docs\Ace-Step UI.ico'
$linkName = 'ACE-Step Studio.lnk'

# Les dossiers suivent la session (Bureau redirige vers OneDrive, langue de Windows...).
$places = @()
if (-not $NoDesktop) { $places += @{ Label = 'Bureau'; Dir = [Environment]::GetFolderPath('Desktop') } }
if (-not $NoMenu) { $places += @{ Label = 'Menu Demarrer'; Dir = [Environment]::GetFolderPath('Programs') } }

if ($Remove) {
    foreach ($p in $places) {
        $f = Join-Path $p.Dir $linkName
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Host ("  Supprime : " + $f) }
    }
    Write-Host '  Raccourcis ACE-Step Studio supprimes.'
    exit 0
}

if (-not (Test-Path -LiteralPath $target)) {
    Write-Host ("  ERREUR : " + $target + " est introuvable.")
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$made = 0
foreach ($p in $places) {
    if ([string]::IsNullOrWhiteSpace($p.Dir) -or -not (Test-Path -LiteralPath $p.Dir)) {
        Write-Host ("  Note : dossier introuvable pour " + $p.Label + ", raccourci non cree.")
        continue
    }
    $f = Join-Path $p.Dir $linkName
    $lnk = $shell.CreateShortcut($f)
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $root
    # Comme sous Linux : fermer la page web arrete le serveur et le moteur (la fenetre noire se ferme avec eux).
    $lnk.Arguments = '--quit-on-close'
    $lnk.Description = 'ACE-Step Studio - generation musicale par IA, en local'
    $lnk.WindowStyle = 1
    if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon + ',0' }
    $lnk.Save()
    Write-Host ("  " + $p.Label + " : " + $f)
    $made++
}
if ($made -gt 0) { Write-Host '  Raccourci ACE-Step Studio pret.' }
