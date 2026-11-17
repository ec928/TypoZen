using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WinForms = System.Windows.Forms;

namespace TypoZen
{
    /// <summary>
    /// A decision the reader has to answer, drawn in the app's colours with the committing
    /// button at the bottom right. The labels stay Yes / No / Cancel / OK, because several
    /// prompts tell the reader what each of those means. Error reports stay on MessageBox.
    /// </summary>
    internal static class ThemedPrompt
    {
        private sealed class Choice
        {
            public string Label;
            public WinForms.DialogResult Result;
        }

        public static WinForms.DialogResult Show(
            string text, string caption,
            WinForms.MessageBoxButtons buttons,
            WinForms.MessageBoxIcon icon)
        {
            return Show(text, caption, buttons, icon, WinForms.MessageBoxDefaultButton.Button1);
        }

        public static WinForms.DialogResult Show(
            string text, string caption,
            WinForms.MessageBoxButtons buttons,
            WinForms.MessageBoxIcon icon,
            WinForms.MessageBoxDefaultButton defaultButton)
        {
            Window owner = null;
            try
            {
                if (Application.Current != null) owner = Application.Current.MainWindow;
            }
            catch { }
            return ShowCore(owner, text, caption, buttons, defaultButton);
        }

        public static MessageBoxResult Show(
            Window owner, string text, string caption,
            MessageBoxButton buttons, MessageBoxImage image)
        {
            WinForms.MessageBoxButtons wb;
            switch (buttons)
            {
                case MessageBoxButton.OKCancel: wb = WinForms.MessageBoxButtons.OKCancel; break;
                case MessageBoxButton.YesNo: wb = WinForms.MessageBoxButtons.YesNo; break;
                case MessageBoxButton.YesNoCancel: wb = WinForms.MessageBoxButtons.YesNoCancel; break;
                default: wb = WinForms.MessageBoxButtons.OK; break;
            }
            switch (ShowCore(owner, text, caption, wb, WinForms.MessageBoxDefaultButton.Button1))
            {
                case WinForms.DialogResult.OK: return MessageBoxResult.OK;
                case WinForms.DialogResult.Cancel: return MessageBoxResult.Cancel;
                case WinForms.DialogResult.Yes: return MessageBoxResult.Yes;
                case WinForms.DialogResult.No: return MessageBoxResult.No;
                default: return MessageBoxResult.None;
            }
        }

        private static WinForms.DialogResult ShowCore(
            Window owner, string text, string caption,
            WinForms.MessageBoxButtons buttons,
            WinForms.MessageBoxDefaultButton defaultButton)
        {
            var choices = new List<Choice>();
            switch (buttons)
            {
                case WinForms.MessageBoxButtons.OKCancel:
                    choices.Add(new Choice { Label = "OK", Result = WinForms.DialogResult.OK });
                    choices.Add(new Choice { Label = "Cancel", Result = WinForms.DialogResult.Cancel });
                    break;
                case WinForms.MessageBoxButtons.YesNo:
                    choices.Add(new Choice { Label = "Yes", Result = WinForms.DialogResult.Yes });
                    choices.Add(new Choice { Label = "No", Result = WinForms.DialogResult.No });
                    break;
                case WinForms.MessageBoxButtons.YesNoCancel:
                    choices.Add(new Choice { Label = "Yes", Result = WinForms.DialogResult.Yes });
                    choices.Add(new Choice { Label = "No", Result = WinForms.DialogResult.No });
                    choices.Add(new Choice { Label = "Cancel", Result = WinForms.DialogResult.Cancel });
                    break;
                default:
                    choices.Add(new Choice { Label = "OK", Result = WinForms.DialogResult.OK });
                    break;
            }

            int defIndex = 0;
            if (defaultButton == WinForms.MessageBoxDefaultButton.Button2 && choices.Count > 1) defIndex = 1;
            else if (defaultButton == WinForms.MessageBoxDefaultButton.Button3 && choices.Count > 2) defIndex = 2;
            Choice primary = choices[defIndex];
            choices.RemoveAt(defIndex);
            choices.Add(primary);

            WinForms.DialogResult fallback = WinForms.DialogResult.OK;
            foreach (var c in choices)
            {
                if (c.Result == WinForms.DialogResult.Cancel) { fallback = WinForms.DialogResult.Cancel; break; }
                if (c.Result == WinForms.DialogResult.No) fallback = WinForms.DialogResult.No;
            }

            string blob = ((caption ?? "") + " " + (text ?? "")).ToLowerInvariant();
            bool destructive = blob.Contains("delete") || blob.Contains("remove ") || blob.Contains("clear all");

            var win = new Window
            {
                Title = string.IsNullOrEmpty(caption) ? "TypoZen" : caption,
                Width = 440,
                SizeToContent = SizeToContent.Height,
                ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false,
                WindowStyle = WindowStyle.SingleBorderWindow,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 13
            };
            try
            {
                if (owner != null && owner.IsLoaded)
                {
                    win.Owner = owner;
                    win.WindowStartupLocation = WindowStartupLocation.CenterOwner;
                }
                else win.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            }
            catch { win.WindowStartupLocation = WindowStartupLocation.CenterScreen; }

            DialogTheme.Apply(win, owner);

            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var body = new TextBlock
            {
                Text = text ?? "",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(20, 18, 20, 8),
                LineHeight = 20
            };
            var scroller = new ScrollViewer
            {
                Content = body,
                MaxHeight = 360,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled
            };
            Grid.SetRow(scroller, 0);
            root.Children.Add(scroller);

            var borderBrush = win.TryFindResource("TzBorder") as Brush;
            var foot = new Border
            {
                BorderThickness = new Thickness(0, 1, 0, 0),
                BorderBrush = borderBrush,
                Padding = new Thickness(16, 12, 16, 14),
                Margin = new Thickness(0, 8, 0, 0)
            };
            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            foot.Child = row;
            Grid.SetRow(foot, 1);
            root.Children.Add(foot);

            WinForms.DialogResult picked = fallback;
            bool first = true;
            foreach (var c in choices)
            {
                var btn = new Button
                {
                    Content = c.Label,
                    MinWidth = 88,
                    Height = 32,
                    Margin = new Thickness(first ? 0 : 8, 0, 0, 0),
                    HorizontalContentAlignment = HorizontalAlignment.Center,
                    IsDefault = object.ReferenceEquals(c, primary),
                    IsCancel = c.Result == fallback
                };
                first = false;
                var captured = c.Result;
                btn.Click += (s, e) => { picked = captured; win.DialogResult = true; };
                if (object.ReferenceEquals(c, primary))
                {
                    bool harm = destructive
                        && (c.Result == WinForms.DialogResult.Yes || c.Result == WinForms.DialogResult.OK);
                    Brush fill;
                    if (harm)
                    {
                        var red = new SolidColorBrush(Color.FromRgb(0xC4, 0x2B, 0x1C));
                        red.Freeze();
                        fill = red;
                    }
                    else
                    {
                        fill = win.TryFindResource("TzAccent") as Brush;
                    }
                    if (fill != null)
                    {
                        btn.Background = fill;
                        btn.BorderBrush = fill;
                    }
                    btn.Foreground = Brushes.White;
                    btn.FontWeight = FontWeights.SemiBold;
                }
                row.Children.Add(btn);
            }

            win.Content = root;
            try { win.ShowDialog(); }
            catch { return fallback; }
            return picked;
        }
    }
}
