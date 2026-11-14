import 'package:flutter/material.dart';

import 'branding/eduos_brand_theme.dart';
import 'branding/eduos_mascot.dart';

void main() => runApp(const EduOsBrandingDemo());

class EduOsBrandingDemo extends StatelessWidget {
  const EduOsBrandingDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const brand = EduOsBrandTheme();
    return MaterialApp(
      title: 'EduOS School Experience',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: brand.primary),
        scaffoldBackgroundColor: brand.surface,
        extensions: const [brand],
        useMaterial3: true,
      ),
      home: const SchoolWelcomeScreen(),
    );
  }
}

class SchoolWelcomeScreen extends StatefulWidget {
  const SchoolWelcomeScreen({super.key});

  @override
  State<SchoolWelcomeScreen> createState() => _SchoolWelcomeScreenState();
}

class _SchoolWelcomeScreenState extends State<SchoolWelcomeScreen> {
  EduMascotAction _action = EduMascotAction.none;
  int _actionSequence = 0;
  double _mood = 0;
  double _lookX = 0;
  double _lookY = 0;

  @override
  Widget build(BuildContext context) {
    final brand = context.eduBrand;
    return Scaffold(
      appBar: AppBar(
        title: const Text('School Experience'),
        backgroundColor: brand.primary,
        foregroundColor: Colors.white,
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Card(
            color: Colors.white,
            elevation: 0,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  const Text('Welcome to our school',
                      style: TextStyle(fontSize: 23, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  Text('A connected place to learn, grow, and belong.',
                      style: TextStyle(color: brand.ink)),
                  const SizedBox(height: 8),
                  EduOsMascot(
                    mood: _mood,
                    action: _action,
                    actionSequence: _actionSequence,
                    lookX: _lookX,
                    lookY: _lookY,
                  ),
                  Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 8,
                    children: [
                      OutlinedButton.icon(
                        onPressed: () => setState(() { _action = EduMascotAction.greet; _actionSequence++; }),
                        icon: const Icon(Icons.waving_hand_outlined),
                        label: const Text('Wave'),
                      ),
                      FilledButton.icon(
                        onPressed: () => setState(() { _action = EduMascotAction.celebrate; _actionSequence++; }),
                        icon: const Icon(Icons.celebration_outlined),
                        label: const Text('Celebrate'),
                      ),
                      OutlinedButton.icon(
                        onPressed: () => setState(() { _action = EduMascotAction.help; _actionSequence++; }),
                        icon: const Icon(Icons.favorite_outline),
                        label: const Text('Need help'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text('Mascot expression',
              style: Theme.of(context).textTheme.titleMedium),
          Slider(
            value: _mood,
            min: 0,
            max: 2,
            divisions: 2,
            label: const ['Neutral', 'Happy', 'Surprised'][_mood.round()],
            onChanged: (value) => setState(() => _mood = value),
          ),
          Text('Eye tracking · horizontal'),
          Slider(
            value: _lookX,
            min: -100,
            max: 100,
            onChanged: (value) => setState(() => _lookX = value),
          ),
          Text('Eye tracking · vertical'),
          Slider(
            value: _lookY,
            min: -100,
            max: 100,
            onChanged: (value) => setState(() => _lookY = value),
          ),
        ],
      ),
    );
  }
}

