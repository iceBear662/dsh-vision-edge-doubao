# dsh-vision-edge-doubao 一键启动脚本（Edge 调试实例 + 豆包桥接）
# 用法：双击运行，或 powershell -ExecutionPolicy Bypass -File start-vision-edge.ps1
# 首次运行会在弹出的 Edge 窗口中登录豆包（登录态保存在独立 profile，之后不用再登）

$ErrorActionPreference = "Stop"

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $edge)) { Write-Host "❌ 找不到 msedge.exe"; exit 1 }

$profileDir = Join-Path $env:USERPROFILE ".vision-edge-profile"
$pluginDir = $PSScriptRoot
$tempImgDir = "C:\Temp\doubao-bridge"

Write-Host "=== 1/4 检查调试端口 9333 ==="
$existing = $null
try { $existing = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/version" -TimeoutSec 5 } catch {}
if ($existing) {
    $browserName = $existing.Browser
    if ($browserName -match "Edg") {
        Write-Host "Edge 调试实例已在运行 ✅ ($browserName)"
    } else {
        Write-Host "⚠️ 9333 被其他浏览器占用: $browserName"
        Write-Host "请先关闭旧调试实例（例如 dsh-vision-web 的 Chrome：任务管理器结束 chrome.exe）后重跑本脚本"
        exit 1
    }
} else {
    Write-Host "启动 Edge 调试实例（独立 profile，登录态已保存）..."
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    New-Item -ItemType Directory -Force -Path $tempImgDir | Out-Null
    Start-Process $edge -ArgumentList @(
        "--remote-debugging-port=9333",
        "--remote-allow-origins=*",
        "--user-data-dir=$profileDir",
        "https://www.doubao.com/chat/"
    )
    Start-Sleep -Seconds 10
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:9333/json/version" -TimeoutSec 5
        Write-Host "Edge 调试实例就绪 ✅"
    } catch {
        Write-Host "⚠️ Edge 启动失败，请检查后重试"; exit 1
    }
}

Write-Host "=== 2/4 检查桥接进程 ==="
$bridgeProc = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -match "bridge-edge\.mjs"
}
if ($bridgeProc) {
    Write-Host "桥接已在运行 (PID $($bridgeProc.ProcessId))"
} else {
    Write-Host "启动桥接 (node bridge-edge.mjs) ..."
    # 安装 puppeteer-core（若缺）
    if (-not (Test-Path (Join-Path $pluginDir "node_modules\puppeteer-core"))) {
        Write-Host "安装 puppeteer-core 依赖（需要网络）..."
        Push-Location $pluginDir
        try {
            npm install puppeteer-core --no-audit --no-fund | Out-Null
            if (-not (Test-Path (Join-Path $pluginDir "node_modules\puppeteer-core"))) { throw "安装失败" }
            Write-Host "puppeteer-core 安装完成 ✅"
        } catch {
            Write-Host "❌ puppeteer-core 安装失败：请检查网络后重新运行本脚本"
            Write-Host "   或手动执行：cd $pluginDir && npm install puppeteer-core"
            Pop-Location
            exit 1
        }
        Pop-Location
    }
    Start-Process node -ArgumentList "bridge-edge.mjs" -WorkingDirectory $pluginDir -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Write-Host "桥接已启动 ✅"
}

Write-Host "=== 3/4 验证队列 ==="
try {
    $null = Invoke-RestMethod -Uri "http://localhost:9340/pending" -TimeoutSec 5
    Write-Host "队列服务可达 ✅（dsh web 的 vision 插件 host 已加载）"
} catch {
    Write-Host "⚠️ 队列服务 (:9340) 不可达 —— 请确认 dsh web 已重启且 dsh-vision-edge-doubao 插件已加载"
}

Write-Host "=== 4/4 完成 ==="
Write-Host "现在可以在 dsh web 里让模型识图（vision 工具 → 豆包 Web 通道 → Edge 桥接）"
Write-Host "数学建模图专项：mode=math（几何/流程图/图表/表格/公式）"
