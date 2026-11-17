using System;
using System.Windows;
using System.Windows.Markup;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// The reader's theme for a code-built window: text boxes, dropdowns, buttons, lists and tabs in
    /// the theme's colours rather than Windows' own white controls, which glared out of a dark theme
    /// in Narrator Manager (Ed, 2026-10-09). The window's background, text colour and accent come
    /// from the main window; everything else is derived from those, so any theme works.
    ///
    ///   DialogTheme.Apply(win, owner);
    /// </summary>
    internal static class DialogTheme
    {
        public static void Apply(Window win, Window owner)
        {
            if (win == null) return;
            var bg = (owner != null ? owner.Background : null) as SolidColorBrush;
            var fg = (owner != null ? owner.Foreground : null) as SolidColorBrush;
            Color b = bg != null ? bg.Color : Colors.White;
            Color t = fg != null ? fg.Color : Colors.Black;
            bool dark = Luma(b) < 0.5;
            Color accent = Accent(owner, b);
            bool darkAccent = RelLuma(accent) <= 0.179;
            Color accentHover = Mix(accent, darkAccent ? 0.14 : -0.10);
            Color accentPressed = Mix(accent, darkAccent ? -0.15 : -0.22);
            Color accentText = darkAccent ? Colors.White : Colors.Black;
            Color danger = Color.FromRgb(0xC4, 0x2B, 0x1C);
            Func<double, SolidColorBrush> shade = amount => Freeze(new SolidColorBrush(Mix(b, amount)));
            Func<Color, double, SolidColorBrush> alpha = (c, a) => Freeze(new SolidColorBrush(Color.FromArgb((byte)(255 * a), c.R, c.G, c.B)));

            var d = (ResourceDictionary)XamlReader.Parse(Styles);
            d["TzBg"] = Freeze(new SolidColorBrush(b));
            d["TzText"] = Freeze(new SolidColorBrush(t));
            d["TzMuted"] = alpha(t, 0.68);
            // Inputs sit a little into the page; buttons stand a little out of it.
            d["TzField"] = shade(dark ? -0.28 : 0.6);
            d["TzButton"] = shade(dark ? 0.10 : -0.05);
            d["TzHover"] = shade(dark ? 0.18 : -0.10);
            d["TzPressed"] = shade(dark ? 0.25 : -0.16);
            d["TzBorder"] = shade(dark ? 0.24 : -0.22);
            d["TzSelected"] = alpha(accent, 0.35);
            d["TzThemeAccentBrush"] = Freeze(new SolidColorBrush(accent));
            d["TzAccent"] = Freeze(new SolidColorBrush(accent));
            d["TzAccentHover"] = Freeze(new SolidColorBrush(accentHover));
            d["TzAccentPressed"] = Freeze(new SolidColorBrush(accentPressed));
            d["TzAccentText"] = Freeze(new SolidColorBrush(accentText));
            d["TzDanger"] = Freeze(new SolidColorBrush(danger));
            d["TzDangerHover"] = Freeze(new SolidColorBrush(Mix(danger, 0.12)));
            d["TzDangerPressed"] = Freeze(new SolidColorBrush(Mix(danger, -0.18)));
            d["TzDangerText"] = Brushes.White;
            d["TzPrimaryButton"] = BuildSolidButtonStyle("TzAccent");
            d["TzDangerButton"] = BuildSolidButtonStyle("TzDanger");
            win.Resources.MergedDictionaries.Add(d);
            if (bg != null) win.Background = bg;
            if (fg != null) win.Foreground = fg;
            ApplyDwmWindowChrome(win, dark);
            win.SourceInitialized += (s, e) => ApplyDwmWindowChrome(win, dark);
        }

        /// <summary>1px top-bordered footer strip shared across TypoZen dialogs.</summary>
        public static System.Windows.Controls.Border MakeFooter(
            Window win, UIElement content, Thickness? padding = null, Thickness? margin = null)
        {
            return new System.Windows.Controls.Border
            {
                BorderThickness = new Thickness(0, 1, 0, 0),
                BorderBrush = win != null ? win.TryFindResource("TzBorder") as Brush : null,
                Padding = padding ?? new Thickness(16, 12, 16, 14),
                Margin = margin ?? new Thickness(0, 8, 0, 0),
                Child = content
            };
        }

        /// <summary>Style a button as the dialog's primary (or destructive) action with accessible hover states.</summary>
        public static void SetPrimary(Window win, System.Windows.Controls.Button btn, bool destructive = false)
        {
            if (win == null || btn == null) return;
            var st = win.TryFindResource(destructive ? "TzDangerButton" : "TzPrimaryButton") as Style;
            if (st != null) btn.Style = st;
        }

        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

        internal static void ApplyDwmWindowChrome(Window win, bool dark)
        {
            if (win == null) return;
            try
            {
                var hwnd = new System.Windows.Interop.WindowInteropHelper(win).Handle;
                if (hwnd == IntPtr.Zero) return;
                int round = 2; // DWMWCP_ROUND (Windows 11; safe no-op on Windows 10)
                DwmSetWindowAttribute(hwnd, 33, ref round, sizeof(int));
                int darkMode = dark ? 1 : 0;
                DwmSetWindowAttribute(hwnd, 20, ref darkMode, sizeof(int));
            }
            catch { }
        }

        /// <summary>The theme's highlight: TypoZen's real accent when readable on bg, or a Fluent blue fallback.</summary>
        private static Color Accent(Window owner, Color bg)
        {
            SolidColorBrush b = null;
            if (owner != null) b = owner.TryFindResource("TzThemeAccentBrush") as SolidColorBrush;
            if (b == null && Application.Current != null && Application.Current.MainWindow != null)
                b = Application.Current.MainWindow.TryFindResource("TzThemeAccentBrush") as SolidColorBrush;
            if (b != null && ContrastRatio(b.Color, bg) >= 2.1) return b.Color;
            return Luma(bg) < 0.5 ? Color.FromRgb(0x5B, 0x9B, 0xF0) : Color.FromRgb(0x2F, 0x6B, 0xD6);
        }

        private static double Luma(Color c) { return (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0; }

        private static double RelLuma(Color c)
        {
            Func<byte, double> lin = v =>
            {
                double s = v / 255.0;
                return s <= 0.03928 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * lin(c.R) + 0.7152 * lin(c.G) + 0.0722 * lin(c.B);
        }

        private static double ContrastRatio(Color a, Color b)
        {
            double l1 = RelLuma(a), l2 = RelLuma(b);
            return (Math.Max(l1, l2) + 0.05) / (Math.Min(l1, l2) + 0.05);
        }

        /// <summary>Towards white (amount &gt; 0) or black (&lt; 0), by that fraction.</summary>
        private static Color Mix(Color c, double amount)
        {
            Func<byte, byte> one = v => amount >= 0
                ? (byte)Math.Round(v + (255 - v) * amount)
                : (byte)Math.Round(v * (1 + amount));
            return Color.FromRgb(one(c.R), one(c.G), one(c.B));
        }

        private static SolidColorBrush Freeze(SolidColorBrush b) { b.Freeze(); return b; }

        private static Style BuildSolidButtonStyle(string prefix)
        {
            string xaml = @"<Style xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
       xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='Button'>
  <Setter Property='Foreground' Value='{DynamicResource {PREFIX}Text}'/>
  <Setter Property='Background' Value='{DynamicResource {PREFIX}}'/>
  <Setter Property='BorderBrush' Value='{DynamicResource {PREFIX}}'/>
  <Setter Property='BorderThickness' Value='1'/>
  <Setter Property='Padding' Value='12,4'/>
  <Setter Property='FontWeight' Value='SemiBold'/>
  <Setter Property='Cursor' Value='Hand'/>
  <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
  <Setter Property='HorizontalContentAlignment' Value='Center'/>
  <Setter Property='Template'>
    <Setter.Value>
      <ControlTemplate TargetType='Button'>
        <Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}'
                BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='4' Padding='{TemplateBinding Padding}'>
          <ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}' VerticalAlignment='Center' RecognizesAccessKey='True'/>
        </Border>
        <ControlTemplate.Triggers>
          <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource {PREFIX}Hover}'/><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource {PREFIX}Hover}'/></Trigger>
          <Trigger Property='IsPressed' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource {PREFIX}Pressed}'/><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource {PREFIX}Pressed}'/></Trigger>
          <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource TzText}'/></Trigger>
          <Trigger Property='IsEnabled' Value='False'><Setter TargetName='b' Property='Opacity' Value='0.45'/></Trigger>
        </ControlTemplate.Triggers>
      </ControlTemplate>
    </Setter.Value>
  </Setter>
</Style>".Replace("{PREFIX}", prefix);
            return (Style)XamlReader.Parse(xaml);
        }

        private const string Styles = @"
<ResourceDictionary xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
                    xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'>
  <Style TargetType='Button'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Background' Value='{DynamicResource TzButton}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource TzBorder}'/>
    <Setter Property='BorderThickness' Value='1'/>
    <Setter Property='Padding' Value='12,4'/>
    <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='Button'>
          <Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}'
                  BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='4' Padding='{TemplateBinding Padding}'>
            <ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}' VerticalAlignment='Center' RecognizesAccessKey='True'/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzHover}'/></Trigger>
            <Trigger Property='IsPressed' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzPressed}'/></Trigger>
            <Trigger Property='IsKeyboardFocused' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource TzAccent}'/></Trigger>
            <Trigger Property='IsEnabled' Value='False'><Setter TargetName='b' Property='Opacity' Value='0.45'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='TextBox'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Background' Value='{DynamicResource TzField}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource TzBorder}'/>
    <Setter Property='CaretBrush' Value='{DynamicResource TzText}'/>
    <Setter Property='SelectionBrush' Value='{DynamicResource TzAccent}'/>
    <Setter Property='BorderThickness' Value='1'/>
    <Setter Property='Padding' Value='6,4'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='TextBox'>
          <Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}'
                  BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='4'>
            <ScrollViewer x:Name='PART_ContentHost' Margin='{TemplateBinding Padding}' Focusable='False'/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsKeyboardFocusWithin' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource TzAccent}'/></Trigger>
            <Trigger Property='IsEnabled' Value='False'><Setter TargetName='b' Property='Opacity' Value='0.5'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='ComboBoxItem'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
    <Setter Property='Padding' Value='8,5'/>
    <Setter Property='Margin' Value='2,1'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ComboBoxItem'>
          <Border x:Name='b' Background='Transparent' CornerRadius='4' Padding='{TemplateBinding Padding}'><ContentPresenter/></Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsSelected' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzSelected}'/></Trigger>
            <Trigger Property='IsHighlighted' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzHover}'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='ComboBox'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Height' Value='28'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ComboBox'>
          <Grid>
            <ToggleButton Focusable='False' ClickMode='Press'
                          IsChecked='{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}'>
              <ToggleButton.Template>
                <ControlTemplate TargetType='ToggleButton'>
                  <Border x:Name='bd' Background='{DynamicResource TzField}' BorderBrush='{DynamicResource TzBorder}' BorderThickness='1' CornerRadius='4'>
                    <Path HorizontalAlignment='Right' VerticalAlignment='Center' Margin='0,0,9,0' Data='M0,0 L4,4 L8,0'
                          Stroke='{DynamicResource TzText}' StrokeThickness='1.5'/>
                  </Border>
                  <ControlTemplate.Triggers>
                    <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='BorderBrush' Value='{DynamicResource TzAccent}'/></Trigger>
                  </ControlTemplate.Triggers>
                </ControlTemplate>
              </ToggleButton.Template>
            </ToggleButton>
            <ContentPresenter x:Name='ContentSite' IsHitTestVisible='False' Margin='8,2,26,2' VerticalAlignment='Center'
                              Content='{TemplateBinding SelectionBoxItem}' ContentTemplate='{TemplateBinding SelectionBoxItemTemplate}'/>
            <TextBox x:Name='PART_EditableTextBox' Style='{x:Null}' Visibility='Hidden' IsReadOnly='{TemplateBinding IsReadOnly}'
                     Margin='2,1,24,1' Padding='6,0,2,0' VerticalContentAlignment='Center'
                     Background='Transparent' BorderThickness='0' Focusable='True'
                     Foreground='{DynamicResource TzText}' CaretBrush='{DynamicResource TzText}'
                     SelectionBrush='{DynamicResource TzAccent}'/>
            <Popup x:Name='PART_Popup' Placement='Bottom' IsOpen='{TemplateBinding IsDropDownOpen}' AllowsTransparency='True'
                   Focusable='False' PopupAnimation='Fade'>
              <Border Background='{DynamicResource TzField}' BorderBrush='{DynamicResource TzBorder}' BorderThickness='1' CornerRadius='8' Padding='2'
                      MinWidth='{TemplateBinding ActualWidth}' MaxHeight='{TemplateBinding MaxDropDownHeight}'>
                <ScrollViewer SnapsToDevicePixels='True'><ItemsPresenter KeyboardNavigation.DirectionalNavigation='Contained'/></ScrollViewer>
              </Border>
            </Popup>
          </Grid>
          <ControlTemplate.Triggers>
            <Trigger Property='IsEditable' Value='True'>
              <Setter Property='IsTabStop' Value='False'/>
              <Setter TargetName='PART_EditableTextBox' Property='Visibility' Value='Visible'/>
              <Setter TargetName='ContentSite' Property='Visibility' Value='Hidden'/>
            </Trigger>
            <Trigger Property='IsEnabled' Value='False'><Setter Property='Opacity' Value='0.5'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='ListBox'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Background' Value='{DynamicResource TzField}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource TzBorder}'/>
    <Setter Property='BorderThickness' Value='1'/>
  </Style>
  <Style TargetType='ListBoxItem'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
    <Setter Property='Padding' Value='8,4'/>
    <Setter Property='Margin' Value='2,1'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ListBoxItem'>
          <Border x:Name='b' Background='Transparent' CornerRadius='4' Padding='{TemplateBinding Padding}'>
            <ContentPresenter HorizontalAlignment='{TemplateBinding HorizontalContentAlignment}'/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzHover}'/></Trigger>
            <Trigger Property='IsSelected' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzSelected}'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='TabItem'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='TabItem'>
          <Border x:Name='b' Background='Transparent' BorderBrush='Transparent' BorderThickness='0,0,0,2'
                  Padding='{TemplateBinding Padding}' Margin='0,0,4,0'>
            <ContentPresenter ContentSource='Header' VerticalAlignment='Center'/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzHover}'/></Trigger>
            <Trigger Property='IsSelected' Value='True'><Setter TargetName='b' Property='BorderBrush' Value='{DynamicResource TzAccent}'/></Trigger>
            <Trigger Property='IsSelected' Value='False'><Setter Property='Opacity' Value='0.7'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <!-- Right-click menus: Windows' own keeps a pale strip for icons down the left, a white
       blob in a dark theme (2026-10-09). -->
  <Style TargetType='ContextMenu'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ContextMenu'>
          <Border Background='{DynamicResource TzField}' BorderBrush='{DynamicResource TzBorder}' BorderThickness='1' CornerRadius='8' Padding='4'>
            <StackPanel IsItemsHost='True' KeyboardNavigation.DirectionalNavigation='Cycle'/>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType='MenuItem'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='MenuItem'>
          <Border x:Name='b' Background='Transparent' Padding='10,6,20,6' Margin='2,1' CornerRadius='4'>
            <ContentPresenter ContentSource='Header' RecognizesAccessKey='True'/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property='IsHighlighted' Value='True'><Setter TargetName='b' Property='Background' Value='{DynamicResource TzHover}'/></Trigger>
            <Trigger Property='IsEnabled' Value='False'><Setter Property='Opacity' Value='0.45'/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType='ProgressBar'>
    <Setter Property='Foreground' Value='{DynamicResource TzAccent}'/>
    <Setter Property='Background' Value='{DynamicResource TzField}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource TzBorder}'/>
    <Setter Property='BorderThickness' Value='1'/>
  </Style>
  <Style TargetType='CheckBox'><Setter Property='Foreground' Value='{DynamicResource TzText}'/><Setter Property='FocusVisualStyle' Value='{x:Null}'/></Style>
  <Style TargetType='RadioButton'><Setter Property='Foreground' Value='{DynamicResource TzText}'/><Setter Property='FocusVisualStyle' Value='{x:Null}'/></Style>
</ResourceDictionary>";
    }
}
