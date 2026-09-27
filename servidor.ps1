# =====================================================================
# servidor.ps1 — Servidor web local para testar o aplicativo
# ---------------------------------------------------------------------
# Não precisa instalar nada: usa o próprio Windows (.NET HttpListener).
# Coloque este arquivo DENTRO da pasta do aplicativo (a mesma do
# index.html) e execute o "iniciar-servidor.bat".
#
# Para encerrar o servidor, feche a janela ou pressione Ctrl+C.
# =====================================================================

$porta = 8080
$raiz  = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Confere se está na pasta certa
if (-not (Test-Path (Join-Path $raiz 'index.html'))) {
    Write-Host ''
    Write-Host '  ERRO: nao encontrei o index.html nesta pasta.' -ForegroundColor Red
    Write-Host "  Pasta atual: $raiz"
    Write-Host '  Coloque o servidor.ps1 e o iniciar-servidor.bat DENTRO da pasta'
    Write-Host '  do aplicativo (onde estao index.html, app.js, config.js...).'
    Write-Host ''
    Read-Host '  Pressione Enter para fechar'
    exit 1
}

# Tipos de arquivo servidos
$tipos = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.pdf'  = 'application/pdf'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.sql'  = 'text/plain; charset=utf-8'
    '.gs'   = 'text/plain; charset=utf-8'
    '.webmanifest' = 'application/manifest+json'
}

$ouvinte = New-Object System.Net.HttpListener
$ouvinte.Prefixes.Add("http://localhost:$porta/")

try {
    $ouvinte.Start()
} catch {
    Write-Host ''
    Write-Host "  ERRO: nao foi possivel abrir a porta $porta." -ForegroundColor Red
    Write-Host '  Provavelmente ja existe outro programa usando essa porta.'
    Write-Host '  Edite este arquivo e troque a linha "$porta = 8080" por 8090.'
    Write-Host ''
    Read-Host '  Pressione Enter para fechar'
    exit 1
}

Write-Host ''
Write-Host '  ============================================================'
Write-Host '   Inspecao de Campo - servidor local iniciado' -ForegroundColor Green
Write-Host '  ============================================================'
Write-Host "   Endereco:  http://localhost:$porta"
Write-Host "   Pasta:     $raiz"
Write-Host ''
Write-Host '   Deixe esta janela ABERTA enquanto usa o aplicativo.'
Write-Host '   Para encerrar: feche a janela ou pressione Ctrl+C.'
Write-Host '  ============================================================'
Write-Host ''

# Abre o navegador. Preferimos o Chrome: o Edge tem um "Modo de leitura"
# que pode abrir sozinho e remove o CSS e o JavaScript da página, fazendo
# o aplicativo parecer quebrado (endereco comecando com read://).
$endereco = "http://localhost:$porta/"
$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
    Start-Process $chrome -ArgumentList "--new-window", $endereco
    Write-Host "   Abrindo no Google Chrome."
} else {
    # Sem Chrome: usa o navegador padrao. Se o Edge abrir em Modo de
    # Leitura (endereco read://...), pressione F9 para sair.
    Start-Process $endereco
    Write-Host "   Abrindo no navegador padrao."
    Write-Host "   Se a pagina abrir sem cores nem botoes (Modo de Leitura do Edge)," -ForegroundColor Yellow
    Write-Host "   pressione F9 na janela do navegador." -ForegroundColor Yellow
}

try {
    while ($ouvinte.IsListening) {

        $contexto  = $ouvinte.GetContext()
        $requisicao = $contexto.Request
        $resposta   = $contexto.Response

        $caminho = [System.Uri]::UnescapeDataString($requisicao.Url.AbsolutePath)
        if ($caminho -eq '/' -or $caminho -eq '') { $caminho = '/index.html' }

        # Monta o caminho físico e bloqueia tentativa de sair da pasta
        $relativo = $caminho.TrimStart('/').Replace('/', '\')
        $arquivo  = Join-Path $raiz $relativo
        $completo = [System.IO.Path]::GetFullPath($arquivo)

        if (-not $completo.StartsWith([System.IO.Path]::GetFullPath($raiz))) {
            $resposta.StatusCode = 403
            $resposta.Close()
            continue
        }

        if (Test-Path $completo -PathType Leaf) {
            try {
                $bytes = [System.IO.File]::ReadAllBytes($completo)
                $ext   = [System.IO.Path]::GetExtension($completo).ToLower()

                $resposta.ContentType = if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' }

                # O service worker nunca pode vir de cache do navegador,
                # senao a atualizacao de versao demora a chegar.
                if ($relativo -ieq 'service-worker.js') {
                    $resposta.Headers.Add('Cache-Control', 'no-cache, no-store, must-revalidate')
                }

                $resposta.ContentLength64 = $bytes.Length
                $resposta.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host ("  200  " + $caminho)
            } catch {
                $resposta.StatusCode = 500
                Write-Host ("  500  " + $caminho) -ForegroundColor Red
            }
        } else {
            $resposta.StatusCode = 404
            $texto = [System.Text.Encoding]::UTF8.GetBytes('404 - arquivo nao encontrado: ' + $caminho)
            $resposta.OutputStream.Write($texto, 0, $texto.Length)
            Write-Host ("  404  " + $caminho) -ForegroundColor Yellow
        }

        $resposta.Close()
    }
} finally {
    $ouvinte.Stop()
    $ouvinte.Close()
    Write-Host ''
    Write-Host '  Servidor encerrado.'
}
