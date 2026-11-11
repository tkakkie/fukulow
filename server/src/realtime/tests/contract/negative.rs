use super::*;

#[sqlx::test]
async fn delivery_contract_rejects_incorrect_unread_counts_and_positions(pool: PgPool) {
    for change_count in [false, true] {
        let mut scenario = scenarios()
            .into_iter()
            .find(|s| s.id == "unread-positions-are-independent-and-monotonic")
            .unwrap();
        let mut changed = None;
        for (step, item) in scenario.steps.iter_mut().enumerate() {
            match item {
                Step::Unread { expect, .. } if change_count => {
                    expect.unread_count += 1;
                    changed = Some(step);
                    break;
                }
                Step::MarkRead {
                    expect_read_seq, ..
                } if !change_count => {
                    *expect_read_seq += 1;
                    changed = Some(step);
                    break;
                }
                _ => {}
            }
        }
        let step = changed.unwrap();
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::Unread { step })
        );
    }
}

#[derive(Clone, Copy, Debug)]
enum Wrong {
    Sequence,
    Watermark,
    CloseCode,
    SilentInsteadOfMessage,
    SilentInsteadOfClose,
    EmptySequences,
    EmptySequencesWithoutPost,
    ReversedSequences,
}

impl Wrong {
    fn assertion(self) -> Assertion {
        match self {
            Self::Sequence => Assertion::Message,
            Self::Watermark => Assertion::Subscribed,
            Self::CloseCode => Assertion::Closed,
            Self::SilentInsteadOfMessage | Self::SilentInsteadOfClose => Assertion::Silence,
            Self::EmptySequences | Self::EmptySequencesWithoutPost | Self::ReversedSequences => {
                Assertion::EmptyMessage
            }
        }
    }

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
                // The already pending message/close must fail this silence assertion,
                // regardless of whether the follow-up subscription could succeed.
                *event = Event::Silent {
                    barrier: Barrier {
                        channel: "general".into(),
                        caught_up_seq: 0,
                    },
                };
                true
            }
            (Self::EmptySequences, Event::Message { seqs, .. }) => {
                *seqs = Some(Vec::new());
                true
            }
            (
                Self::EmptySequencesWithoutPost,
                Event::Message {
                    seqs, from_post, ..
                },
            ) => {
                *seqs = Some(Vec::new());
                *from_post = None;
                true
            }
            (
                Self::ReversedSequences,
                Event::Message {
                    seqs, from_post, ..
                },
            ) => {
                *seqs = Some(vec![Seq::Range { from: 2, to: 1 }]);
                *from_post = None;
                true
            }
            _ => false,
        }
    }
}

// Setup panics, read timeouts and failures at any other step/event do not count.
#[sqlx::test]
async fn delivery_contract_rejects_incorrect_expectations(pool: PgPool) {
    for wrong in [
        Wrong::Sequence,
        Wrong::Watermark,
        Wrong::CloseCode,
        Wrong::SilentInsteadOfMessage,
        Wrong::SilentInsteadOfClose,
        Wrong::EmptySequences,
        Wrong::EmptySequencesWithoutPost,
        Wrong::ReversedSequences,
    ] {
        let (scenario, step, event) = scenarios()
            .into_iter()
            .find_map(|mut scenario| {
                for (step, item) in scenario.steps.iter_mut().enumerate() {
                    if let Step::Expect { events, .. } = item {
                        for (event, expectation) in events.iter_mut().enumerate() {
                            if wrong.change(expectation) {
                                return Some((scenario, step, event));
                            }
                        }
                    }
                }
                None
            })
            .unwrap_or_else(|| panic!("no fixture exercises {wrong:?}"));
        let result = tokio::spawn(Runner::run(pool.clone(), scenario))
            .await
            .unwrap();
        assert_eq!(
            result,
            Err(Failure::Expectation {
                step,
                event,
                assertion: wrong.assertion()
            }),
            "{wrong:?}"
        );
    }
}

#[sqlx::test]
async fn delivery_contract_rejects_public_members_even_when_empty(pool: PgPool) {
    for members in [vec![], vec!["alice".into()]] {
        let mut scenario = scenarios()
            .into_iter()
            .find(|s| s.setup.channels.iter().any(|c| c.visibility == "public"))
            .unwrap();
        let channel = scenario
            .setup
            .channels
            .iter_mut()
            .find(|c| c.visibility == "public")
            .unwrap();
        channel.members = Some(members);
        let label = channel.id.clone();
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::PublicMembers(label))
        );
    }
}

#[sqlx::test]
async fn subscription_limit_contract_rejects_delivery_to_unsubscribed_channel(pool: PgPool) {
    let mut scenario = scenarios()
        .into_iter()
        .find(|s| s.id == "subscription-limit-is-refused-then-recovers-after-unsubscribe")
        .unwrap();
    // Free a different slot: bulk#2 wrongly remains subscribed, while the positive
    // control on bulk#257 still succeeds. Only the new target silence must fail.
    let channel = scenario
        .steps
        .iter_mut()
        .find_map(|step| match step {
            Step::Unsubscribe { channel, .. } => Some(channel),
            _ => None,
        })
        .unwrap();
    *channel = ChannelRef::Label("bulk#3".into());
    let step = scenario.steps.len() - 1;
    assert!(
        matches!(&scenario.steps[step], Step::Expect { events, .. } if matches!(events.as_slice(), [Event::Silent { .. }]))
    );
    assert_eq!(
        Runner::run(pool, scenario).await,
        Err(Failure::Expectation {
            step,
            event: 0,
            assertion: Assertion::Silence
        })
    );
}

#[sqlx::test]
async fn handoff_contract_rejects_omission_and_reordering(pool: PgPool) {
    for seqs in [
        vec![Seq::Range { from: 9, to: 125 }],
        vec![
            Seq::Number(9),
            Seq::Number(8),
            Seq::Range { from: 10, to: 125 },
        ],
    ] {
        let mut scenario = scenarios()
            .into_iter()
            .find(|s| s.id == "handoff-with-concurrent-sends-keeps-order-and-omits-nothing")
            .unwrap();
        let mut seqs = Some(seqs);
        let (step, event) = scenario
            .steps
            .iter_mut()
            .enumerate()
            .find_map(|(step, item)| {
                if let Step::Expect { events, .. } = item {
                    for (event, expectation) in events.iter_mut().enumerate() {
                        if let Event::Message { seqs: target, .. } = expectation {
                            *target = seqs.take();
                            return Some((step, event));
                        }
                    }
                }
                None
            })
            .unwrap();
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::Expectation {
                step,
                event,
                assertion: Assertion::Message
            })
        );
    }
}

// A stand-in for the serialized server send path: the wrong earlier delivery finishes
// after the former quiet window, before the drain acknowledgement. A timer-only
// silence implementation returns Ok and fails this negative test.
#[tokio::test]
async fn silence_barrier_rejects_late_wrong_delivery_and_close() {
    for wrong in [1, 2, 3, 0] {
        let channel = Uuid::new_v4();
        let subscribed = json!({"type":"subscribed","channel_id":channel,"caught_up_seq":0});
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = socket.next().await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(request.to_text().unwrap()).unwrap(),
                json!({"type":"subscribe","channel_id":channel,"after_seq":0})
            );
            tokio::time::sleep(Duration::from_millis(150)).await;
            match wrong {
                1 => socket
                    .send(tungstenite::Message::text(
                        json!({"type":"message","message":{"channel_id":Uuid::new_v4(),"seq":1}})
                            .to_string(),
                    ))
                    .await
                    .unwrap(),
                2 => {
                    socket
                        .send(tungstenite::Message::Close(Some(
                            tungstenite::protocol::CloseFrame {
                                code: 4008.into(),
                                reason: "".into(),
                            },
                        )))
                        .await
                        .unwrap();
                    return;
                }
                3 => socket
                    .send(tungstenite::Message::text(subscribed.to_string()))
                    .await
                    .unwrap(),
                _ => {}
            }
            socket
                .send(tungstenite::Message::text(subscribed.to_string()))
                .await
                .unwrap();
            // Read ping only after the serialized send path has finished, as the
            // real connection does; tungstenite queues an automatic pong on read.
            let tungstenite::Message::Ping(nonce) = socket.next().await.unwrap().unwrap() else {
                panic!("expected barrier ping");
            };
            socket
                .send(tungstenite::Message::Pong(nonce))
                .await
                .unwrap();
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let result = assertions::silence(&mut client, channel, 0).await;
        assert_eq!(
            result,
            if wrong != 0 {
                Err(Assertion::Silence)
            } else {
                Ok(())
            }
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn silence_barrier_returns_typed_failure_for_each_closed_socket_write() {
    for fail_at in [0, 1] {
        // Inject the close at each write, after the initial read could have polled
        // Pending. TCP timing cannot deterministically exercise both write errors.
        let sink = futures_util::sink::unfold(0, move |sent, frame| async move {
            if sent == 0 {
                assert!(matches!(frame, tungstenite::Message::Text(_)));
            } else {
                assert!(matches!(frame, tungstenite::Message::Ping(_)));
            }
            if sent == fail_at {
                Err(tungstenite::Error::ConnectionClosed)
            } else {
                Ok(sent + 1)
            }
        });
        let mut sink = Box::pin(sink);
        assert_eq!(
            assertions::barrier_controls(&mut sink, Uuid::new_v4(), 0).await,
            Err(Assertion::Silence),
            "write {fail_at}"
        );
    }
}

#[tokio::test]
async fn silence_barrier_returns_typed_failure_after_server_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket.close(None).await.unwrap();
    });
    let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
        .await
        .unwrap();
    assert!(matches!(
        frame(&mut client).await,
        tungstenite::Message::Close(_)
    ));
    assert_eq!(
        assertions::barrier_controls(&mut client, Uuid::new_v4(), 0).await,
        Err(Assertion::Silence)
    );
    assert_eq!(
        assertions::silence(&mut client, Uuid::new_v4(), 0).await,
        Err(Assertion::Read)
    );
    task.await.unwrap();
}

#[sqlx::test]
async fn delivery_contract_rejects_empty_channel_ranges(pool: PgPool) {
    for kind in ["message", "subscribed", "error"] {
        let (scenario, step, event) = scenarios()
            .into_iter()
            .find_map(|mut scenario| {
                for (step, item) in scenario.steps.iter_mut().enumerate() {
                    if let Step::Expect { events, .. } = item {
                        for (event, expectation) in events.iter_mut().enumerate() {
                            let channel = match expectation {
                                Event::Message { channel, .. } if kind == "message" => channel,
                                Event::Subscribed { channel, .. } if kind == "subscribed" => {
                                    channel
                                }
                                Event::Error {
                                    channel: Some(channel),
                                    ..
                                } if kind == "error" => channel,
                                _ => continue,
                            };
                            *channel = ChannelRef::Range {
                                group: "unused".into(),
                                from: 2,
                                to: 1,
                            };
                            return Some((scenario, step, event));
                        }
                    }
                }
                None
            })
            .unwrap();
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::Expectation {
                step,
                event,
                assertion: Assertion::EmptyChannel
            }),
            "{kind}"
        );
    }
}

#[sqlx::test]
async fn timeline_contract_rejects_incorrect_pages(pool: PgPool) {
    for wrong in 0..7 {
        let mut scenario = scenarios()
            .into_iter()
            .find(|s| s.id == "main-timeline-pages-as-of-w-while-posting")
            .unwrap();
        let (step, spec) = scenario
            .steps
            .iter_mut()
            .enumerate()
            .find_map(|(step, item)| {
                if let Step::MainTimeline(spec) = item {
                    Some((step, spec))
                } else {
                    None
                }
            })
            .unwrap();
        match wrong {
            0 => spec.expect.as_of_seq -= 1,
            1 => spec.expect.has_more = false,
            2 => {
                spec.expect.items.remove(0);
            }
            3 => spec.expect.items.reverse(),
            4 => {
                if let TimelineItem::Topic { topic } = &mut spec.expect.items[1] {
                    topic.message_count += 1;
                }
            }
            5 => {
                if let TimelineItem::Topic { topic } = &mut spec.expect.items[2] {
                    topic.last_seq = 6;
                }
            }
            _ => {
                spec.expect.items[1] = TimelineItem::Message {
                    message: TimelineMessage { seq: 9 },
                }
            }
        }
        assert_eq!(
            Runner::run(pool.clone(), scenario).await,
            Err(Failure::Timeline { step }),
            "mutation {wrong}"
        );
    }
}
