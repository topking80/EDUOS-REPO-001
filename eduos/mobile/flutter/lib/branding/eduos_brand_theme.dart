import 'package:flutter/material.dart';

/// Centralized, replaceable school-brand tokens. District deployments should
/// load approved tenant branding from a trusted configuration endpoint.
@immutable
class EduOsBrandTheme extends ThemeExtension<EduOsBrandTheme> {
  const EduOsBrandTheme({
    this.primary = const Color(0xFF173B63),
    this.secondary = const Color(0xFF20A4A8),
    this.accent = const Color(0xFFF2B544),
    this.surface = const Color(0xFFF4F7FB),
    this.ink = const Color(0xFF18283A),
  });

  final Color primary;
  final Color secondary;
  final Color accent;
  final Color surface;
  final Color ink;

  @override
  EduOsBrandTheme copyWith({
    Color? primary,
    Color? secondary,
    Color? accent,
    Color? surface,
    Color? ink,
  }) => EduOsBrandTheme(
        primary: primary ?? this.primary,
        secondary: secondary ?? this.secondary,
        accent: accent ?? this.accent,
        surface: surface ?? this.surface,
        ink: ink ?? this.ink,
      );

  @override
  EduOsBrandTheme lerp(ThemeExtension<EduOsBrandTheme>? other, double t) {
    if (other is! EduOsBrandTheme) return this;
    return EduOsBrandTheme(
      primary: Color.lerp(primary, other.primary, t)!,
      secondary: Color.lerp(secondary, other.secondary, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
    );
  }
}

extension EduOsBrandThemeContext on BuildContext {
  EduOsBrandTheme get eduBrand =>
      Theme.of(this).extension<EduOsBrandTheme>() ?? const EduOsBrandTheme();
}
