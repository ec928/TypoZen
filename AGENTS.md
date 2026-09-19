---
name: TypoZen UX Guidelines
description: Strict guidelines for all UI/UX modifications to TypoZen
trigger: always_on
---

# TypoZen UI/UX Philosophy

TypoZen is a minimalist, distraction-free text editor and EPUB reader. Its primary goal is to stay out of the user's way and let the content breathe. 

When modifying the UI or adding features, you **MUST** adhere to the following strict guidelines:

1. **No Floating Obtrusive Overlays:** Never inject floating HTML/CSS widgets (like media players, toolbars, or fixed-position blocks) that obscure the main text or title. 
2. **Native Over Web:** Prefer using native WPF menus, dialogs, and controls (in `TypoZen.xaml` and `TypoZen_App.cs`) over building bulky HTML/CSS bolt-ons in the WebView.
3. **Use Existing Discrete Patterns:** If a feature must be in the HTML view, integrate it quietly into the existing discrete controls (e.g., the text selection popup). 
4. **Assume High Competence:** The user is an expert. Do not add hand-holding, excessive margins, rounded-corner bubbly UI, or anything that detracts from a professional, dense information layout.

**Rule of Thumb:** If a feature takes up permanent pixel space in the main reading window, you have failed the UX design. Hide it in a native menu, a settings dialog, or a contextual popup.
