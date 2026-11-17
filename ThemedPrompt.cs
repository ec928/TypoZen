using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WinForms = System.Windows.Forms;

namespace TypoZen
{
    /// <summary>
    /// A decision or notice the reader answers, drawn in TypoZen's active theme colours
    /// with the committing action on the bottom right. Startup/fatal errors before a WPF
    /// window exists still fall back to WinForms MessageBox.
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
            return Show(ActiveOwner(), text, caption, buttons, icon, defaultButton);
        }

        public static WinForms.DialogResult Show(
            Window owner, string text, string caption,
            WinForms.MessageBoxButtons buttons,
            WinForms.MessageBoxIcon icon,
            WinForms.MessageBoxDefaultButton defaultButton = WinForms.MessageBoxDefaultButton.Button1)
        {
            var choices = StandardChoices(buttons);
            return ShowCore(owner ?? ActiveOwner(), text, caption, choices, defaultButton, false, null);
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
            switch (Show(owner, text, caption, wb, WinForms.MessageBoxIcon.None, WinForms.MessageBoxDefaultButton.Button1))
            {
                case WinForms.DialogResult.OK: return MessageBoxResult.OK;
                case WinForms.DialogResult.Cancel: return MessageBoxResult.Cancel;
                case WinForms.DialogResult.Yes: return MessageBoxResult.Yes;
                case WinForms.DialogResult.No: return MessageBoxResult.No;
                default: return MessageBoxResult.None;
            }
        }

        /// <summary>Prompt with explicit verb button labels mapped back to DialogResult.</summary>
        public static WinForms.DialogResult ShowChoices(
            string text, string caption,
            string yesLabel, string noLabel, string cancelLabel,
            WinForms.MessageBoxDefaultButton defaultButton = WinForms.MessageBoxDefaultButton.Button1,
            bool destructive = false,
            WinForms.DialogResult? escapeResult = null)
        {
            var choices = new List<Choice>();
            if (!string.IsNullOrEmpty(yesLabel))
                choices.Add(new Choice { Label = yesLabel, Result = WinForms.DialogResult.Yes });
            if (!string.IsNullOrEmpty(noLabel))
                choices.Add(new Choice { Label = noLabel, Result = WinForms.DialogResult.No });
            if (!string.IsNullOrEmpty(cancelLabel))
                choices.Add(new Choice { Label = cancelLabel, Result = WinForms.DialogResult.Cancel });
            if (choices.Count == 0)
                choices.Add(new Choice { Label = "OK", Result = WinForms.DialogResult.OK });
            return ShowCore(ActiveOwner(), text, caption, choices, defaultButton, destructive, escapeResult);
        }

        private static Window ActiveOwner()
        {
            try
            {
                if (Application.Current != null) return Application.Current.MainWindow;
            }
            catch { }
            return null;
        }

        private static List<Choice> StandardChoices(WinForms.MessageBoxButtons buttons)
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
            return choices;
        }

        private static WinForms.DialogResult ShowCore(
            Window owner, string text, string caption,
            List<Choice> choices,
            WinForms.MessageBoxDefaultButton defaultButton,
            bool forceDestructive,
            WinForms.DialogResult? escapeResult)
        {
            int defIndex = 0;
            if (defaultButton == WinForms.MessageBoxDefaultButton.Button2 && choices.Count > 1) defIndex = 1;
            else if (defaultButton == WinForms.MessageBoxDefaultButton.Button3 && choices.Count > 2) defIndex = 2;
            Choice primary = choices[defIndex];
            choices.RemoveAt(defIndex);
            choices.Add(primary);

            WinForms.DialogResult fallback = escapeResult ?? WinForms.DialogResult.OK;
            if (!escapeResult.HasValue)
            {
                foreach (var c in choices)
                {
                    if (c.Result == WinForms.DialogResult.Cancel) { fallback = WinForms.DialogResult.Cancel; break; }
                    if (c.Result == WinForms.DialogResult.No) fallback = WinForms.DialogResult.No;
                }
            }

            string blob = (caption ?? "") + " " + (text ?? "");
            bool destructive = forceDestructive
                || Regex.IsMatch(blob, @"\b(delete|remove|clear all)\b", RegexOptions.IgnoreCase);

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

            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            var foot = DialogTheme.MakeFooter(win, row);
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
                    Padding = new Thickness(14, 4, 14, 4),
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
                    DialogTheme.SetPrimary(win, btn, harm);
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
