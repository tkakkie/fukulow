use super::*;

impl Runner {
    pub(super) async fn timeline(
        &mut self,
        step: usize,
        spec: TimelineSpec,
    ) -> Result<(), Failure> {
        for label in spec.channel.labels() {
            let channel = self.channels[&label];
            let query = spec
                .query
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&");
            let (status, page) = http::request(
                self.server.address,
                "GET",
                format!("/api/v1/channels/{channel}/timeline?{query}"),
                &self.members[&spec.member].token,
                Value::Null,
            )
            .await;
            let items = spec.expect.items.iter().map(|item| match item {
                TimelineItem::Message { message } => json!({"kind":"message","message":self.records[&(channel, message.seq)]}),
                TimelineItem::Topic { topic } => {
                    let id = &self.topics[&(channel, topic.name.clone())];
                    let first_seq = self.records.iter().filter(|((id_channel, seq), record)| {
                        *id_channel == channel && *seq <= spec.expect.as_of_seq && record["topic_id"] == *id
                    }).map(|((_, seq), _)| *seq).min().unwrap();
                    json!({"kind":"topic","topic":{
                        "id":id,"name":topic.name,"first_seq":first_seq,"last_seq":topic.last_seq,
                        "message_count":topic.message_count,"latest_message":self.records[&(channel, topic.last_seq)],
                        "read_seq":topic.read_seq,"unread_count":topic.unread_count,"mention_unread_count":0
                    }})
                }
            }).collect::<Vec<_>>();
            let expected = json!({"as_of_seq":spec.expect.as_of_seq,"items":items,"has_more":spec.expect.has_more});
            if status != spec.expect.status || page != expected {
                eprintln!(
                    "timeline: expected status {} {expected}, got {status} {page}",
                    spec.expect.status
                );
                return Err(Failure::Timeline { step });
            }
        }
        Ok(())
    }
}
