from music21 import key, note, stream

from services.music21_svc import _infer_key_signatures


def _score_with_opening_pitches():
    score = stream.Score()
    part = stream.Part()
    measure = stream.Measure(number=1)
    pitches = ["A-4", "C5", "E-5", "A-4", "C5", "F5", "A-4", "C5", "E-5", "F5", "B-4", "D-5"] * 6
    for i, pitch_name in enumerate(pitches):
        measure.insert(i * 0.5, note.Note(pitch_name, quarterLength=0.5))
    part.append(measure)
    score.append(part)
    return score


def test_infers_confident_opening_key_and_respelled_notes():
    score = _score_with_opening_pitches()

    _infer_key_signatures(score)

    signatures = list(score.recurse().getElementsByClass(key.KeySignature))
    assert signatures
    assert signatures[0].sharps == -4
    assert any(p.name == "A-" for n in score.recurse().notes for p in n.pitches)


def test_adds_only_confident_persistent_key_changes():
    score = stream.Score()
    part = stream.Part()
    flat_key = ["A-4", "C5", "E-5", "A-4", "C5", "F5", "A-4", "C5", "E-5", "F5", "B-4", "D-5"]
    e_major = ["E4", "G#4", "B4", "C#5", "E4", "G#4", "B4", "C#5"] * 2
    for measure_number in range(1, 41):
        pitches = flat_key if measure_number <= 24 else e_major
        measure = stream.Measure(number=measure_number)
        for i, pitch_name in enumerate(pitches):
            measure.insert(i * 0.25, note.Note(pitch_name, quarterLength=0.25))
        part.append(measure)
    score.append(part)

    _infer_key_signatures(score)

    signatures = [(m.number, list(m.getElementsByClass(key.KeySignature))) for m in part.getElementsByClass(stream.Measure)]
    changes = [(number, items[0].sharps) for number, items in signatures if items]
    assert changes[0][1] == -4
    assert any(number > 1 and sharps == 4 for number, sharps in changes)


def test_disabling_analysis_adds_no_signatures():
    score = _score_with_opening_pitches()

    _infer_key_signatures(score, enabled=False)

    assert not list(score.recurse().getElementsByClass(key.KeySignature))


def test_preserves_existing_key_signature():
    score = _score_with_opening_pitches()
    existing = key.KeySignature(2)
    score.parts[0].measure(1).insert(0, existing)

    _infer_key_signatures(score)

    signatures = list(score.recurse().getElementsByClass(key.KeySignature))
    assert len(signatures) == 1
    assert signatures[0].sharps == 2
