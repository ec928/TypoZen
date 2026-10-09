using System;
using System.Windows;
using System.Windows.Markup;
using System.Windows.Media;

namespace TypoZen
{
    /// <summary>
    /// The reader's theme for a code-built window: text boxes, dropdowns, buttons, lists and tabs in
    /// the theme's colours rather than Windows' own white controls, which glared out of a dark theme
    /// in Narrator Settings (Ed, 2026-10-09). The window's background and text colour come from the
    /// main window; everything else is derived from those two, so any theme works.
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
            d["TzSelected"] = alpha(Accent(b, t), 0.35);
            d["TzAccent"] = Freeze(new SolidColorBrush(Accent(b, t)));
            win.Resources.MergedDictionaries.Add(d);
            if (bg != null) win.Background = bg;
            if (fg != null) win.Foreground = fg;
        }

        /// <summary>The theme's highlight: the accent TypoZen's buttons use, readable on this background.</summary>
        private static Color Accent(Color bg, Color text)
        {
            return Luma(bg) < 0.5 ? Color.FromRgb(0x5B, 0x9B, 0xF0) : Color.FromRgb(0x2F, 0x6B, 0xD6);
        }

        private static double Luma(Color c) { return (0.2126 * c.R + 0.7152 * c.G + 0.0722 * c.B) / 255.0; }

        /// <summary>Towards white (amount &gt; 0) or black (&lt; 0), by that fraction.</summary>
        private static Color Mix(Color c, double amount)
        {
            Func<byte, byte> one = v => amount >= 0
                ? (byte)Math.Round(v + (255 - v) * amount)
                : (byte)Math.Round(v * (1 + amount));
            return Color.FromRgb(one(c.R), one(c.G), one(c.B));
        }

        private static SolidColorBrush Freeze(SolidColorBrush b) { b.Freeze(); return b; }

        private const string Styles = @"
<ResourceDictionary xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
                    xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'>
  <Style TargetType='Button'>
    <Setter Property='Foreground' Value='{DynamicResource TzText}'/>
    <Setter Property='Background' Value='{DynamicResource TzButton}'/>
    <Setter Property='BorderBrush' Value='{DynamicResource TzBorder}'/>
    <Setter Property='BorderThickness' Value='1'/>
    <Setter Property='Padding' Value='12,2'/>
    <Setter Property='FocusVisualStyle' Value='{x:Null}'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='Button'>
          <Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}'
                  BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='3' Padding='{TemplateBinding Padding}'>
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
    <Setter Property='Padding' Value='4,3'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='TextBox'>
          <Border x:Name='b' Background='{TemplateBinding Background}' BorderBrush='{TemplateBinding BorderBrush}'
                  BorderThickness='{TemplateBinding BorderThickness}' CornerRadius='3'>
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
    <Setter Property='Padding' Value='8,4'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ComboBoxItem'>
          <Border x:Name='b' Background='Transparent' Padding='{TemplateBinding Padding}'><ContentPresenter/></Border>
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
                  <Border x:Name='bd' Background='{DynamicResource TzField}' BorderBrush='{DynamicResource TzBorder}' BorderThickness='1' CornerRadius='3'>
                    <Path HorizontalAlignment='Right' VerticalAlignment='Center' Margin='0,0,9,0' Data='M0,0 L4,4 L8,0'
                          Stroke='{DynamicResource TzText}' StrokeThickness='1.5'/>
                  </Border>
                  <ControlTemplate.Triggers>
                    <Trigger Property='IsMouseOver' Value='True'><Setter TargetName='bd' Property='BorderBrush' Value='{DynamicResource TzAccent}'/></Trigger>
                  </ControlTemplate.Triggers>
                </ControlTemplate>
              </ToggleButton.Template>
            </ToggleButton>
            <ContentPresenter IsHitTestVisible='False' Margin='8,2,26,2' VerticalAlignment='Center'
                              Content='{TemplateBinding SelectionBoxItem}' ContentTemplate='{TemplateBinding SelectionBoxItemTemplate}'/>
            <Popup x:Name='PART_Popup' Placement='Bottom' IsOpen='{TemplateBinding IsDropDownOpen}' AllowsTransparency='True'
                   Focusable='False' PopupAnimation='Fade'>
              <Border Background='{DynamicResource TzField}' BorderBrush='{DynamicResource TzBorder}' BorderThickness='1'
                      MinWidth='{TemplateBinding ActualWidth}' MaxHeight='{TemplateBinding MaxDropDownHeight}'>
                <ScrollViewer SnapsToDevicePixels='True'><ItemsPresenter KeyboardNavigation.DirectionalNavigation='Contained'/></ScrollViewer>
              </Border>
            </Popup>
          </Grid>
          <ControlTemplate.Triggers>
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
    <Setter Property='Padding' Value='6,3'/>
    <Setter Property='Template'>
      <Setter.Value>
        <ControlTemplate TargetType='ListBoxItem'>
          <Border x:Name='b' Background='Transparent' Padding='{TemplateBinding Padding}'>
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

  <Style TargetType='CheckBox'><Setter Property='Foreground' Value='{DynamicResource TzText}'/></Style>
  <Style TargetType='RadioButton'><Setter Property='Foreground' Value='{DynamicResource TzText}'/></Style>
</ResourceDictionary>";
    }
}
