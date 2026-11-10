// Seed data loaded on first run. Edit freely.
const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Hamstrings', 'Glutes', 'Calves', 'Core', 'Cardio', 'Other'];
const EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Band', 'Other'];

// [name, muscle, equipment]
const SEED_EXERCISES = [
  ['Barbell Back Squat', 'Legs', 'Barbell'],
  ['Front Squat', 'Legs', 'Barbell'],
  ['Goblet Squat', 'Legs', 'Kettlebell'],
  ['Leg Press', 'Legs', 'Machine'],
  ['Walking Lunge', 'Legs', 'Dumbbell'],
  ['Bulgarian Split Squat', 'Legs', 'Dumbbell'],
  ['Leg Extension', 'Legs', 'Machine'],
  ['Deadlift', 'Back', 'Barbell'],
  ['Romanian Deadlift', 'Hamstrings', 'Barbell'],
  ['Lying Leg Curl', 'Hamstrings', 'Machine'],
  ['Hip Thrust', 'Glutes', 'Barbell'],
  ['Cable Kickback', 'Glutes', 'Cable'],
  ['Standing Calf Raise', 'Calves', 'Machine'],
  ['Bench Press', 'Chest', 'Barbell'],
  ['Incline Dumbbell Press', 'Chest', 'Dumbbell'],
  ['Dumbbell Bench Press', 'Chest', 'Dumbbell'],
  ['Push-up', 'Chest', 'Bodyweight'],
  ['Cable Fly', 'Chest', 'Cable'],
  ['Dip', 'Chest', 'Bodyweight'],
  ['Overhead Press', 'Shoulders', 'Barbell'],
  ['Dumbbell Shoulder Press', 'Shoulders', 'Dumbbell'],
  ['Lateral Raise', 'Shoulders', 'Dumbbell'],
  ['Face Pull', 'Shoulders', 'Cable'],
  ['Rear Delt Fly', 'Shoulders', 'Dumbbell'],
  ['Pull-up', 'Back', 'Bodyweight'],
  ['Chin-up', 'Back', 'Bodyweight'],
  ['Lat Pulldown', 'Back', 'Cable'],
  ['Barbell Row', 'Back', 'Barbell'],
  ['Seated Cable Row', 'Back', 'Cable'],
  ['One-Arm Dumbbell Row', 'Back', 'Dumbbell'],
  ['Barbell Curl', 'Arms', 'Barbell'],
  ['Dumbbell Curl', 'Arms', 'Dumbbell'],
  ['Hammer Curl', 'Arms', 'Dumbbell'],
  ['Triceps Pushdown', 'Arms', 'Cable'],
  ['Overhead Triceps Extension', 'Arms', 'Dumbbell'],
  ['Skull Crusher', 'Arms', 'Barbell'],
  ['Plank', 'Core', 'Bodyweight'],
  ['Hanging Leg Raise', 'Core', 'Bodyweight'],
  ['Cable Crunch', 'Core', 'Cable'],
  ['Ab Wheel Rollout', 'Core', 'Other'],
  ['Kettlebell Swing', 'Glutes', 'Kettlebell'],
  ['Rowing Machine', 'Cardio', 'Machine'],
];

// Starter templates: [exercise name, sets, target reps]
const SEED_TEMPLATES = [
  {
    name: 'Lower Body',
    items: [
      ['Barbell Back Squat', 4, '5'],
      ['Romanian Deadlift', 3, '8'],
      ['Leg Press', 3, '10-12'],
      ['Lying Leg Curl', 3, '12'],
      ['Standing Calf Raise', 3, '15'],
    ],
  },
  {
    name: 'Upper Body',
    items: [
      ['Bench Press', 4, '5'],
      ['Barbell Row', 4, '8'],
      ['Overhead Press', 3, '8'],
      ['Lat Pulldown', 3, '10-12'],
      ['Dumbbell Curl', 2, '12'],
      ['Triceps Pushdown', 2, '12'],
    ],
  },
  {
    name: 'Full Body',
    items: [
      ['Deadlift', 3, '5'],
      ['Incline Dumbbell Press', 3, '10'],
      ['Pull-up', 3, '8'],
      ['Walking Lunge', 2, '10'],
      ['Hanging Leg Raise', 3, '10'],
    ],
  },
];
