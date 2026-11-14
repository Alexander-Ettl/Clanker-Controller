<#
  "Sign in again" popup for the Clanker Controller, shown when a CLI is signed out while prompts wait to be sent.
  A separate Windows window (not an IDE notification) because the IDE is often minimised or on another desktop when this
  matters. Inputs arrive as environment variables so no text is spliced into this script: AUTH_TITLE, AUTH_MESSAGE,
  AUTH_STEPS (lines), AUTH_BUTTON (empty = nothing to press), AUTH_ERROR, AUTH_ICON (PNG).
  Prints "act" when the main button was pressed, "later" otherwise. AUTH_SHOT=<png> renders the popup to that file and
  exits without showing it (used to check the design).
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
        SizeToContent="Height" Width="500" Topmost="True" WindowStartupLocation="CenterScreen"
        FontFamily="Segoe UI Variable Text, Segoe UI" UseLayoutRounding="True" SnapsToDevicePixels="True"
        Title="Clanker Controller">
  <Window.Resources>
    <Style x:Key="Pill" TargetType="Button">
      <Setter Property="Height" Value="38"/>
      <Setter Property="Padding" Value="20,0"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Face" CornerRadius="19" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Face" Property="Opacity" Value="0.86"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="Face" Property="Opacity" Value="0.7"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Face" Property="BorderBrush" Value="#FFFFFFFF"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border Margin="20" CornerRadius="22" Background="#F2141417" BorderBrush="#2EFFFFFF" BorderThickness="1" Padding="28,26,28,24">
    <Border.Effect><DropShadowEffect BlurRadius="30" ShadowDepth="8" Direction="270" Opacity="0.55"/></Border.Effect>
    <StackPanel>
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
        <Image x:Name="Icon" Width="52" Height="52" VerticalAlignment="Top" Margin="0,0,18,0" RenderOptions.BitmapScalingMode="HighQuality"/>
        <StackPanel Grid.Column="1">
          <TextBlock x:Name="Title" FontSize="19" FontWeight="SemiBold" Foreground="#FFF4F4F5" TextWrapping="Wrap"/>
          <TextBlock x:Name="Message" Margin="0,8,0,0" FontSize="13" LineHeight="19" Foreground="#FFA1A1AA" TextWrapping="Wrap"/>
        </StackPanel>
      </Grid>
      <Border x:Name="StepsBox" Margin="0,20,0,0" Padding="16,14,16,6" CornerRadius="14" Background="#10FFFFFF" BorderBrush="#14FFFFFF" BorderThickness="1">
        <StackPanel x:Name="Steps"/>
      </Border>
      <TextBlock x:Name="Problem" Margin="0,14,0,0" FontSize="12.5" Foreground="#FFFF8A80" TextWrapping="Wrap" Visibility="Collapsed"/>
      <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,22,0,0">
        <Button x:Name="Later" Style="{StaticResource Pill}" Content="Not now" Margin="0,0,10,0" Background="#12FFFFFF" BorderBrush="#1FFFFFFF" Foreground="#FFD4D4D8"/>
        <Button x:Name="Act" Style="{StaticResource Pill}" Background="#FFE8795A" BorderBrush="#FFE8795A" Foreground="#FF1A0F0B" IsDefault="True"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$find = { param($name) $window.FindName($name) }
$window.Title = 'Clanker Controller'
(& $find 'Title').Text = $env:AUTH_TITLE
(& $find 'Message').Text = $env:AUTH_MESSAGE

if ($env:AUTH_ICON -and (Test-Path -LiteralPath $env:AUTH_ICON)) {
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit(); $bitmap.CacheOption = 'OnLoad'; $bitmap.UriSource = [Uri]$env:AUTH_ICON; $bitmap.EndInit()
    (& $find 'Icon').Source = $bitmap
}

$steps = & $find 'Steps'
$number = 0
foreach ($line in ($env:AUTH_STEPS -split "`n" | Where-Object { $_.Trim() })) {
    $number++
    $row = New-Object Windows.Controls.Grid
    $row.Margin = '0,0,0,10'
    $row.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = [Windows.GridLength]::Auto }))
    $row.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
    $badge = New-Object Windows.Controls.Border -Property @{ Width = 22; Height = 22; CornerRadius = 11; VerticalAlignment = 'Top'; Margin = '0,0,12,0'
        Background = (New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(0x33, 0xE8, 0x79, 0x5A))) }
    $badge.Child = New-Object Windows.Controls.TextBlock -Property @{ Text = "$number"; FontSize = 12; FontWeight = 'SemiBold'; HorizontalAlignment = 'Center'; VerticalAlignment = 'Center'
        Foreground = (New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(0xF0, 0x9A, 0x82))) }
    $text = New-Object Windows.Controls.TextBlock -Property @{ Text = $line.Trim(); FontSize = 13; TextWrapping = 'Wrap'; VerticalAlignment = 'Center'; LineHeight = 20
        Foreground = (New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(0xE4, 0xE4, 0xE7))) }
    [Windows.Controls.Grid]::SetColumn($text, 1)
    [void]$row.Children.Add($badge); [void]$row.Children.Add($text)
    [void]$steps.Children.Add($row)
}
if ($number -eq 0) { (& $find 'StepsBox').Visibility = 'Collapsed' }

if ($env:AUTH_ERROR) { $problem = & $find 'Problem'; $problem.Text = $env:AUTH_ERROR; $problem.Visibility = 'Visible' }

$act = & $find 'Act'
$later = & $find 'Later'
if ($env:AUTH_BUTTON) { $act.Content = $env:AUTH_BUTTON } else { $act.Visibility = 'Collapsed'; $later.Content = 'OK'; $later.IsDefault = $true; $later.Background = $act.Background; $later.BorderBrush = $act.BorderBrush; $later.Foreground = $act.Foreground }

$script:answer = 'later'
$act.Add_Click({ $script:answer = 'act'; $window.Close() })
$later.Add_Click({ $window.Close() })
$window.Add_KeyDown({ if ($_.Key -eq 'Escape') { $window.Close() } })
$window.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch { } })

if ($env:AUTH_SHOT) {
    # Layout without showing: measure at the window's width, draw, save.
    $content = $window.Content
    $content.Measure([Windows.Size]::new(500, [double]::PositiveInfinity))
    $height = [Math]::Ceiling($content.DesiredSize.Height)
    $content.Arrange([Windows.Rect]::new(0, 0, 500, $height))
    $content.UpdateLayout()
    $scale = 2
    $target = [Windows.Media.Imaging.RenderTargetBitmap]::new([int](500 * $scale), [int]($height * $scale), 96 * $scale, 96 * $scale, [Windows.Media.PixelFormats]::Pbgra32)
    $target.Render($content)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($target))
    $stream = [IO.File]::Create($env:AUTH_SHOT); $encoder.Save($stream); $stream.Close()
    exit 0
}

[void]$window.ShowDialog()
Write-Output $script:answer
