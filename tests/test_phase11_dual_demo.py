import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]/'tools'))
import train_phase11_dual_demo as demo


def event(start, seconds=120):
    return {'segment':'s','started_at':start,'ended_at':start+seconds*1000,
            'known_at':start+seconds*1000+1000,'seconds':seconds,
            'crossing_lower':start+seconds*1000-60000,'crossing_upper':start+seconds*1000,
            'provenance':'observed','queries':[{'t':start,'available':start+1000}]}


class DualTests(unittest.TestCase):
    def setUp(self):
        self.at=1790640000000  # whole hour
        self.history=[event(self.at-i*3600000) for i in range(1,8)]

    def test_future_target_changes_never_change_features(self):
        a=demo.make_rows(self.history+[event(self.at)],{'s'},'eta')[-1]
        b=demo.make_rows(self.history+[event(self.at,600)],{'s'},'eta')[-1]
        self.assertEqual(a['features'],b['features'])
        self.assertLess(a['history_latest'],a['at'])

    def test_hidden_block_labels_do_not_leak(self):
        target=event(self.at+20*60000)
        hidden=event(self.at+5*60000,120)
        a=demo.make_rows(self.history+[hidden,target],{'s'},'imputation',40)[-1]
        b=demo.make_rows(self.history+[event(self.at+5*60000,900),target],{'s'},'imputation',40)[-1]
        self.assertEqual(a['features'],b['features'])
        self.assertLess(a['history_latest'],a['cutoff'])

    def test_imputed_training_labels_are_rejected(self):
        e=event(self.at);e['provenance']='estimated'
        with self.assertRaises(ValueError):demo.validate_events({'version':2,'target':'next_stop_first_observed','segments':[e]})

    def test_duplicate_and_invalid_labels_rejected(self):
        e=event(self.at)
        with self.assertRaises(ValueError):demo.validate_events({'version':2,'target':'next_stop_first_observed','segments':[e,e]})
        e['known_at']=e['started_at']
        with self.assertRaises(ValueError):demo.validate_events({'version':2,'target':'next_stop_first_observed','segments':[e]})

    def test_mask_durations_select_only_hidden_origins(self):
        for gap in [1,10,40]:
            rows=demo.make_rows(self.history+[event(self.at+gap*60000-1000),event(self.at+gap*60000)],{'s'},'imputation',gap)
            self.assertTrue(all(r['at']%3600000<gap*60000 for r in rows))

if __name__=='__main__':unittest.main()
