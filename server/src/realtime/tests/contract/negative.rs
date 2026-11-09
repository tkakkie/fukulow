use super::*;

#[derive(Clone, Copy, Debug)]
enum Wrong {
    Sequence,
    Watermark,
    CloseCode,
    SilentInsteadOfMessage,
    SilentInsteadOfClose,
}

impl Wrong {
    fn change(self, event: &mut Event) -> bool {
        match (self, event) {
            (
                Self::Sequence,
                Event::Message {
                    seqs: Some(seqs), ..
                },
            ) => {
                if let Some(Seq::Range { from, to }) = seqs.first_mut()
                    && *from < *to
                {
                    *from += 1;
                    return true;
                }
                false
            }
            (Self::Watermark, Event::Subscribed { caught_up_seq, .. }) => {
                *caught_up_seq += 1;
                true
            }
            (Self::CloseCode, Event::Closed { code }) => {
                *code = if *code == 4001 { 4008 } else { 4001 };
                true
            }
            (Self::SilentInsteadOfMessage, event @ Event::Message { .. })
            | (Self::SilentInsteadOfClose, event @ Event::Closed { .. }) => {
                *event = Event::Silent;
                true
            }
            _ => false,
        }
    }
}

// Mutate expectations of otherwise passing real-server fixtures. These prove the
// interpreter rejects bad observations, including both traffic and close in silence.
#[sqlx::test]
async fn delivery_contract_rejects_incorrect_expectations(pool: PgPool) {
    for wrong in [
        Wrong::Sequence,
        Wrong::Watermark,
        Wrong::CloseCode,
        Wrong::SilentInsteadOfMessage,
        Wrong::SilentInsteadOfClose,
    ] {
        let scenario = scenarios()
            .into_iter()
            .find_map(|mut scenario| {
                let changed = scenario.steps.iter_mut().any(|step| match step {
                    Step::Expect { events, .. } => {
                        events.iter_mut().any(|event| wrong.change(event))
                    }
                    _ => false,
                });
                changed.then_some(scenario)
            })
            .unwrap_or_else(|| panic!("no fixture exercises {wrong:?}"));
        let result = tokio::spawn(Runner::run(pool.clone(), scenario)).await;
        let error = result.expect_err("incorrect expectations were accepted");
        assert!(error.is_panic(), "{wrong:?}: {error}");
    }
}
