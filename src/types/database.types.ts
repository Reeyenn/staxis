export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          hotel_id: string
          id: string
          invited_by: string
          role: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at: string
          hotel_id: string
          id?: string
          invited_by: string
          role: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          hotel_id?: string
          id?: string
          invited_by?: string
          role?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_invites_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_lifecycle_intents: {
        Row: {
          abort_reason: string | null
          aborted_at: string | null
          account_id: string
          actor_account_id: string
          actor_auth_user_id: string
          actor_email: string | null
          attempt_count: number
          auth_banned_until_snapshot: string | null
          auth_snapshot_recorded_at: string | null
          auth_user_id_snapshot: string
          committed_at: string | null
          compensates_operation_id: string | null
          created_at: string
          desired_active: boolean
          hotel_id: string
          last_attempt_at: string | null
          last_error: string | null
          operation_id: string
          prior_active: boolean
          processor_lease_expires_at: string | null
          processor_token: string | null
          status: string
          target_property_access_snapshot: string[]
          target_role_snapshot: string
          updated_at: string
          version: number
        }
        Insert: {
          abort_reason?: string | null
          aborted_at?: string | null
          account_id: string
          actor_account_id: string
          actor_auth_user_id: string
          actor_email?: string | null
          attempt_count?: number
          auth_banned_until_snapshot?: string | null
          auth_snapshot_recorded_at?: string | null
          auth_user_id_snapshot: string
          committed_at?: string | null
          compensates_operation_id?: string | null
          created_at?: string
          desired_active: boolean
          hotel_id: string
          last_attempt_at?: string | null
          last_error?: string | null
          operation_id: string
          prior_active: boolean
          processor_lease_expires_at?: string | null
          processor_token?: string | null
          status?: string
          target_property_access_snapshot: string[]
          target_role_snapshot: string
          updated_at?: string
          version: number
        }
        Update: {
          abort_reason?: string | null
          aborted_at?: string | null
          account_id?: string
          actor_account_id?: string
          actor_auth_user_id?: string
          actor_email?: string | null
          attempt_count?: number
          auth_banned_until_snapshot?: string | null
          auth_snapshot_recorded_at?: string | null
          auth_user_id_snapshot?: string
          committed_at?: string | null
          compensates_operation_id?: string | null
          created_at?: string
          desired_active?: boolean
          hotel_id?: string
          last_attempt_at?: string | null
          last_error?: string | null
          operation_id?: string
          prior_active?: boolean
          processor_lease_expires_at?: string | null
          processor_token?: string | null
          status?: string
          target_property_access_snapshot?: string[]
          target_role_snapshot?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "account_lifecycle_intents_compensates_operation_id_fkey"
            columns: ["compensates_operation_id"]
            isOneToOne: false
            referencedRelation: "account_lifecycle_intents"
            referencedColumns: ["operation_id"]
          },
        ]
      }
      account_property_staff_links: {
        Row: {
          account_id: string
          deactivated_at: string | null
          deactivated_by_account_id: string | null
          is_active: boolean
          linked_at: string
          linked_by_account_id: string | null
          property_id: string
          source: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          deactivated_at?: string | null
          deactivated_by_account_id?: string | null
          is_active?: boolean
          linked_at?: string
          linked_by_account_id?: string | null
          property_id: string
          source?: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          deactivated_at?: string | null
          deactivated_by_account_id?: string | null
          is_active?: boolean
          linked_at?: string
          linked_by_account_id?: string | null
          property_id?: string
          source?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_property_staff_links_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_deactivated_by_account_id_fkey"
            columns: ["deactivated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_linked_by_account_id_fkey"
            columns: ["linked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_property_staff_links_staff_property_fkey"
            columns: ["staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      accounts: {
        Row: {
          active: boolean
          ai_cost_tier: string
          created_at: string
          data_user_id: string
          display_name: string
          id: string
          last_seen_at: string | null
          lifecycle_committed_version: number
          lifecycle_desired_active: boolean
          lifecycle_intent_version: number
          password_hash: string | null
          phone: string | null
          preferred_language: string | null
          property_access: string[]
          role: string
          skip_2fa: boolean
          staff_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          active?: boolean
          ai_cost_tier?: string
          created_at?: string
          data_user_id: string
          display_name: string
          id?: string
          last_seen_at?: string | null
          lifecycle_committed_version?: number
          lifecycle_desired_active?: boolean
          lifecycle_intent_version?: number
          password_hash?: string | null
          phone?: string | null
          preferred_language?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          staff_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          active?: boolean
          ai_cost_tier?: string
          created_at?: string
          data_user_id?: string
          display_name?: string
          id?: string
          last_seen_at?: string | null
          lifecycle_committed_version?: number
          lifecycle_desired_active?: boolean
          lifecycle_intent_version?: number
          password_hash?: string | null
          phone?: string | null
          preferred_language?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          staff_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          actor_account_id: string | null
          actor_name: string | null
          actor_role: string | null
          created_at: string
          description: string
          event_category: string
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          property_id: string
          source: string
          source_event_id: string | null
          target_id: string | null
          target_label: string | null
          target_type: string | null
        }
        Insert: {
          actor_account_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          description: string
          event_category: string
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          property_id: string
          source?: string
          source_event_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Update: {
          actor_account_id?: string | null
          actor_name?: string | null
          actor_role?: string | null
          created_at?: string
          description?: string
          event_category?: string
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          property_id?: string
          source?: string
          source_event_id?: string | null
          target_id?: string | null
          target_label?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_user_id: string | null
          id: string
          metadata: Json
          target_id: string | null
          target_type: string | null
          ts: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          ts?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_user_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          ts?: string
        }
        Relationships: []
      }
      agent_actions: {
        Row: {
          action_key: string
          agent_id: string
          contacts_guest: boolean
          created_at: string
          decided_at: string | null
          decided_by: string | null
          describe_en: string | null
          describe_es: string | null
          describe_key: string | null
          describe_params: Json
          exec_idempotency_key: string | null
          id: string
          payload: Json
          property_id: string
          result: Json | null
          run_id: string
          spends_money: boolean
          status: string
        }
        Insert: {
          action_key: string
          agent_id: string
          contacts_guest?: boolean
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          describe_en?: string | null
          describe_es?: string | null
          describe_key?: string | null
          describe_params?: Json
          exec_idempotency_key?: string | null
          id?: string
          payload?: Json
          property_id: string
          result?: Json | null
          run_id: string
          spends_money?: boolean
          status?: string
        }
        Update: {
          action_key?: string
          agent_id?: string
          contacts_guest?: boolean
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          describe_en?: string | null
          describe_es?: string | null
          describe_key?: string | null
          describe_params?: Json
          exec_idempotency_key?: string | null
          id?: string
          payload?: Json
          property_id?: string
          result?: Json | null
          run_id?: string
          spends_money?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_actions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_actions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_conversations: {
        Row: {
          created_at: string
          id: string
          last_summarized_at: string | null
          message_count: number
          prompt_version: string | null
          property_id: string
          role: string
          title: string | null
          unsummarized_message_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          prompt_version?: string | null
          property_id: string
          role: string
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          prompt_version?: string | null
          property_id?: string
          role?: string
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_conversations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_conversations_archived: {
        Row: {
          archived_at: string
          created_at: string
          id: string
          last_summarized_at: string | null
          message_count: number
          prompt_version: string | null
          property_id: string
          role: string
          title: string | null
          unsummarized_message_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          prompt_version?: string | null
          property_id: string
          role: string
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string
          created_at?: string
          id?: string
          last_summarized_at?: string | null
          message_count?: number
          prompt_version?: string | null
          property_id?: string
          role?: string
          title?: string | null
          unsummarized_message_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_cost_finalize_failures: {
        Row: {
          actual_cost_usd: number
          attempt_count: number
          cached_input_tokens: number | null
          conversation_id: string | null
          created_at: string
          id: string
          last_error: string | null
          model: string | null
          model_id: string | null
          property_id: string
          reservation_id: string
          tokens_in: number | null
          tokens_out: number | null
          user_id: string
        }
        Insert: {
          actual_cost_usd: number
          attempt_count?: number
          cached_input_tokens?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          model?: string | null
          model_id?: string | null
          property_id: string
          reservation_id: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_id: string
        }
        Update: {
          actual_cost_usd?: number
          attempt_count?: number
          cached_input_tokens?: number | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          model?: string | null
          model_id?: string | null
          property_id?: string
          reservation_id?: string
          tokens_in?: number | null
          tokens_out?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_cost_finalize_failures_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_cost_finalize_failures_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_cost_finalize_failures_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_costs: {
        Row: {
          cached_input_tokens: number
          conversation_id: string | null
          cost_usd: number
          created_at: string
          id: string
          kind: string
          model: string
          model_id: string | null
          property_id: string
          state: string
          swept_at: string | null
          tokens_in: number
          tokens_out: number
          user_id: string
        }
        Insert: {
          cached_input_tokens?: number
          conversation_id?: string | null
          cost_usd: number
          created_at?: string
          id?: string
          kind?: string
          model: string
          model_id?: string | null
          property_id: string
          state?: string
          swept_at?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id: string
        }
        Update: {
          cached_input_tokens?: number
          conversation_id?: string | null
          cost_usd?: number
          created_at?: string
          id?: string
          kind?: string
          model?: string
          model_id?: string | null
          property_id?: string
          state?: string
          swept_at?: string | null
          tokens_in?: number
          tokens_out?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_costs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_costs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_costs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_decisions: {
        Row: {
          actor_account_id: string | null
          actor_kind: string
          actor_role: string | null
          args_diff: Json | null
          business_date: string
          conversation_id: string | null
          created_at: string
          decision_ms: number | null
          error: string | null
          executed_args: Json | null
          feedback_at: string | null
          feedback_by: string | null
          feedback_note: string | null
          feedback_rating: number | null
          id: string
          model_id: string | null
          occurred_at: string
          outcome_facts: Json | null
          outcome_kind: string | null
          outcome_observed_at: string | null
          pending_action_id: string | null
          prompt_version: string | null
          property_id: string
          proposed_args: Json
          result: Json | null
          state_snapshot: Json
          state_snapshot_hash: string
          surface: string
          tool_name: string
        }
        Insert: {
          actor_account_id?: string | null
          actor_kind: string
          actor_role?: string | null
          args_diff?: Json | null
          business_date: string
          conversation_id?: string | null
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          feedback_at?: string | null
          feedback_by?: string | null
          feedback_note?: string | null
          feedback_rating?: number | null
          id?: string
          model_id?: string | null
          occurred_at?: string
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          pending_action_id?: string | null
          prompt_version?: string | null
          property_id: string
          proposed_args?: Json
          result?: Json | null
          state_snapshot: Json
          state_snapshot_hash: string
          surface: string
          tool_name: string
        }
        Update: {
          actor_account_id?: string | null
          actor_kind?: string
          actor_role?: string | null
          args_diff?: Json | null
          business_date?: string
          conversation_id?: string | null
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          feedback_at?: string | null
          feedback_by?: string | null
          feedback_note?: string | null
          feedback_rating?: number | null
          id?: string
          model_id?: string | null
          occurred_at?: string
          outcome_facts?: Json | null
          outcome_kind?: string | null
          outcome_observed_at?: string | null
          pending_action_id?: string | null
          prompt_version?: string | null
          property_id?: string
          proposed_args?: Json
          result?: Json | null
          state_snapshot?: Json
          state_snapshot_hash?: string
          surface?: string
          tool_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_decisions_actor_account_id_fkey"
            columns: ["actor_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_feedback_by_fkey"
            columns: ["feedback_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_decisions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_eval_baselines: {
        Row: {
          cached_input_tokens: number
          case_name: string
          cost_usd: number
          created_at: string
          duration_ms: number | null
          id: string
          model: string
          model_id: string | null
          passed: boolean
          prompt_version: string
          tokens_in: number
          tokens_out: number
        }
        Insert: {
          cached_input_tokens?: number
          case_name: string
          cost_usd: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          model: string
          model_id?: string | null
          passed: boolean
          prompt_version: string
          tokens_in: number
          tokens_out: number
        }
        Update: {
          cached_input_tokens?: number
          case_name?: string
          cost_usd?: number
          created_at?: string
          duration_ms?: number | null
          id?: string
          model?: string
          model_id?: string | null
          passed?: boolean
          prompt_version?: string
          tokens_in?: number
          tokens_out?: number
        }
        Relationships: []
      }
      agent_memory: {
        Row: {
          confidence: string
          content: string
          created_at: string
          created_by_account_id: string | null
          created_by_name: string | null
          created_by_role: string | null
          expires_at: string | null
          id: string
          is_active: boolean
          last_used_at: string | null
          property_id: string
          scope: string
          source: string
          source_conversation_id: string | null
          subject_account_id: string | null
          superseded_by: string | null
          topic: string
          updated_at: string
          use_count: number
        }
        Insert: {
          confidence?: string
          content: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          property_id: string
          scope: string
          source?: string
          source_conversation_id?: string | null
          subject_account_id?: string | null
          superseded_by?: string | null
          topic: string
          updated_at?: string
          use_count?: number
        }
        Update: {
          confidence?: string
          content?: string
          created_at?: string
          created_by_account_id?: string | null
          created_by_name?: string | null
          created_by_role?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          property_id?: string
          scope?: string
          source?: string
          source_conversation_id?: string | null
          subject_account_id?: string | null
          superseded_by?: string | null
          topic?: string
          updated_at?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory_consolidations: {
        Row: {
          conversations_reviewed: number
          cost_usd: number
          created_at: string
          id: string
          learned_count: number
          model: string | null
          model_id: string | null
          operational_learned_count: number
          operational_recap: string | null
          operational_updated_count: number
          property_id: string
          ran_at: string
          recap: string | null
          run_date: string
          updated_count: number
        }
        Insert: {
          conversations_reviewed?: number
          cost_usd?: number
          created_at?: string
          id?: string
          learned_count?: number
          model?: string | null
          model_id?: string | null
          operational_learned_count?: number
          operational_recap?: string | null
          operational_updated_count?: number
          property_id: string
          ran_at?: string
          recap?: string | null
          run_date: string
          updated_count?: number
        }
        Update: {
          conversations_reviewed?: number
          cost_usd?: number
          created_at?: string
          id?: string
          learned_count?: number
          model?: string | null
          model_id?: string | null
          operational_learned_count?: number
          operational_recap?: string | null
          operational_updated_count?: number
          property_id?: string
          ran_at?: string
          recap?: string | null
          run_date?: string
          updated_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_consolidations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages: {
        Row: {
          content: string | null
          conversation_id: string
          cost_usd: number | null
          created_at: string
          id: string
          is_error: boolean | null
          is_summarized: boolean
          is_summary: boolean
          model_id: string | null
          model_used: string | null
          prompt_version: string | null
          property_id: string
          role: string
          tokens_in: number | null
          tokens_out: number | null
          tool_args: Json | null
          tool_call_id: string | null
          tool_name: string | null
          tool_result: Json | null
        }
        Insert: {
          content?: string | null
          conversation_id: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          property_id: string
          role: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Update: {
          content?: string | null
          conversation_id?: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          property_id?: string
          role?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_messages_archived: {
        Row: {
          archived_at: string
          content: string | null
          conversation_id: string
          cost_usd: number | null
          created_at: string
          id: string
          is_error: boolean | null
          is_summarized: boolean
          is_summary: boolean
          model_id: string | null
          model_used: string | null
          prompt_version: string | null
          role: string
          tokens_in: number | null
          tokens_out: number | null
          tool_args: Json | null
          tool_call_id: string | null
          tool_name: string | null
          tool_result: Json | null
        }
        Insert: {
          archived_at?: string
          content?: string | null
          conversation_id: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          role: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Update: {
          archived_at?: string
          content?: string | null
          conversation_id?: string
          cost_usd?: number | null
          created_at?: string
          id?: string
          is_error?: boolean | null
          is_summarized?: boolean
          is_summary?: boolean
          model_id?: string | null
          model_used?: string | null
          prompt_version?: string | null
          role?: string
          tokens_in?: number | null
          tokens_out?: number | null
          tool_args?: Json | null
          tool_call_id?: string | null
          tool_name?: string | null
          tool_result?: Json | null
        }
        Relationships: []
      }
      agent_nudges: {
        Row: {
          acknowledged_at: string | null
          category: string
          created_at: string
          dedupe_key: string | null
          id: string
          payload: Json
          property_id: string
          severity: string
          status: string
          user_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          category: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          payload: Json
          property_id: string
          severity?: string
          status?: string
          user_id: string
        }
        Update: {
          acknowledged_at?: string | null
          category?: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          payload?: Json
          property_id?: string
          severity?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_nudges_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_nudges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_pending_actions: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          decision_ms: number | null
          error: string | null
          executed_args: Json | null
          expires_at: string
          id: string
          property_id: string
          resolved_at: string | null
          result: Json | null
          resume_claimed_at: string | null
          state_snapshot_hash: string | null
          status: string
          tier: string
          tool_args: Json
          tool_call_id: string
          tool_name: string
          turn_key: string
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          expires_at?: string
          id?: string
          property_id: string
          resolved_at?: string | null
          result?: Json | null
          resume_claimed_at?: string | null
          state_snapshot_hash?: string | null
          status?: string
          tier: string
          tool_args: Json
          tool_call_id: string
          tool_name: string
          turn_key: string
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          decision_ms?: number | null
          error?: string | null
          executed_args?: Json | null
          expires_at?: string
          id?: string
          property_id?: string
          resolved_at?: string | null
          result?: Json | null
          resume_claimed_at?: string | null
          state_snapshot_hash?: string | null
          status?: string
          tier?: string
          tool_args?: Json
          tool_call_id?: string
          tool_name?: string
          turn_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_pending_actions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_pending_actions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_pending_actions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_prompts: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          notes: string | null
          parent_version: string | null
          pms_family: string | null
          role: string
          version: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          parent_version?: string | null
          pms_family?: string | null
          role: string
          version: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          parent_version?: string | null
          pms_family?: string | null
          role?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_prompts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_reminders: {
        Row: {
          body: string
          canceled_at: string | null
          claim_token: string | null
          claimed_at: string | null
          created_at: string
          created_by_staff_id: string | null
          fire_at: string
          fired_at: string | null
          id: string
          property_id: string
          target_department: string | null
          target_staff_id: string | null
        }
        Insert: {
          body: string
          canceled_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          fire_at: string
          fired_at?: string | null
          id?: string
          property_id: string
          target_department?: string | null
          target_staff_id?: string | null
        }
        Update: {
          body?: string
          canceled_at?: string | null
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          fire_at?: string
          fired_at?: string | null
          id?: string
          property_id?: string
          target_department?: string | null
          target_staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_reminders_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_reminders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_reminders_target_staff_id_fkey"
            columns: ["target_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_id: string
          approximations: Json
          as_of_date: string | null
          error: string | null
          event_id: string | null
          finished_at: string | null
          id: string
          inputs_snapshot: Json
          mode: string
          property_id: string
          run_local_date: string
          started_at: string
          status: string
          summary: string | null
          summary_key: string | null
          summary_params: Json
          trigger_source: string
          triggered_by: string | null
        }
        Insert: {
          agent_id: string
          approximations?: Json
          as_of_date?: string | null
          error?: string | null
          event_id?: string | null
          finished_at?: string | null
          id?: string
          inputs_snapshot?: Json
          mode: string
          property_id: string
          run_local_date: string
          started_at?: string
          status?: string
          summary?: string | null
          summary_key?: string | null
          summary_params?: Json
          trigger_source: string
          triggered_by?: string | null
        }
        Update: {
          agent_id?: string
          approximations?: Json
          as_of_date?: string | null
          error?: string | null
          event_id?: string | null
          finished_at?: string | null
          id?: string
          inputs_snapshot?: Json
          mode?: string
          property_id?: string
          run_local_date?: string
          started_at?: string
          status?: string
          summary?: string | null
          summary_key?: string | null
          summary_params?: Json
          trigger_source?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_runs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_voice_sessions: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          current_room_number: string | null
          data_user_id: string
          elevenlabs_call_duration_secs: number | null
          elevenlabs_conversation_id: string | null
          elevenlabs_cost_ingested_at: string | null
          elevenlabs_cost_usd: number | null
          expires_at: string
          id: string
          last_turn_at: string | null
          mode: string | null
          property_id: string
          role_snapshot: string
          staff_id_snapshot: string | null
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          current_room_number?: string | null
          data_user_id: string
          elevenlabs_call_duration_secs?: number | null
          elevenlabs_conversation_id?: string | null
          elevenlabs_cost_ingested_at?: string | null
          elevenlabs_cost_usd?: number | null
          expires_at?: string
          id?: string
          last_turn_at?: string | null
          mode?: string | null
          property_id: string
          role_snapshot: string
          staff_id_snapshot?: string | null
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          current_room_number?: string | null
          data_user_id?: string
          elevenlabs_call_duration_secs?: number | null
          elevenlabs_conversation_id?: string | null
          elevenlabs_cost_ingested_at?: string | null
          elevenlabs_cost_usd?: number | null
          expires_at?: string
          id?: string
          last_turn_at?: string | null
          mode?: string | null
          property_id?: string
          role_snapshot?: string
          staff_id_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_voice_sessions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_voice_sessions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_voice_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          config: Json
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          last_run_at: string | null
          last_run_local_date: string | null
          name: string
          property_id: string
          status: string
          template_key: string | null
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_run_at?: string | null
          last_run_local_date?: string | null
          name: string
          property_id: string
          status?: string
          template_key?: string | null
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_run_at?: string | null
          last_run_local_date?: string | null
          name?: string
          property_id?: string
          status?: string
          template_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_feature_config_versions: {
        Row: {
          activated_at: string | null
          activated_by: string | null
          activated_by_email: string | null
          change_reason: string | null
          created_at: string
          created_by: string | null
          created_by_email: string | null
          enabled: boolean
          fallback_model_id: string | null
          fallback_provider: string | null
          feature_key: string
          id: string
          is_active: boolean
          parameters: Json
          parent_id: string | null
          primary_model_id: string
          primary_provider: string
          validated_at: string | null
          validated_by: string | null
          validated_by_email: string | null
          validation_report: Json
          validation_status: string
          version: number
        }
        Insert: {
          activated_at?: string | null
          activated_by?: string | null
          activated_by_email?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          created_by_email?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          fallback_provider?: string | null
          feature_key: string
          id?: string
          is_active?: boolean
          parameters?: Json
          parent_id?: string | null
          primary_model_id: string
          primary_provider: string
          validated_at?: string | null
          validated_by?: string | null
          validated_by_email?: string | null
          validation_report?: Json
          validation_status?: string
          version: number
        }
        Update: {
          activated_at?: string | null
          activated_by?: string | null
          activated_by_email?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          created_by_email?: string | null
          enabled?: boolean
          fallback_model_id?: string | null
          fallback_provider?: string | null
          feature_key?: string
          id?: string
          is_active?: boolean
          parameters?: Json
          parent_id?: string | null
          primary_model_id?: string
          primary_provider?: string
          validated_at?: string | null
          validated_by?: string | null
          validated_by_email?: string | null
          validation_report?: Json
          validation_status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_feature_config_versions_activated_by_fkey"
            columns: ["activated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "ai_feature_config_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_feature_config_versions_validated_by_fkey"
            columns: ["validated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_model_catalog: {
        Row: {
          available: boolean
          capabilities: string[]
          display_name: string
          first_seen_at: string
          last_seen_at: string
          max_input_tokens: number | null
          max_output_tokens: number | null
          model_id: string
          pricing: Json | null
          provider: string
          raw_metadata: Json
          released_at: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          available?: boolean
          capabilities?: string[]
          display_name: string
          first_seen_at?: string
          last_seen_at?: string
          max_input_tokens?: number | null
          max_output_tokens?: number | null
          model_id: string
          pricing?: Json | null
          provider: string
          raw_metadata?: Json
          released_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          available?: boolean
          capabilities?: string[]
          display_name?: string
          first_seen_at?: string
          last_seen_at?: string
          max_input_tokens?: number | null
          max_output_tokens?: number | null
          model_id?: string
          pricing?: Json | null
          provider?: string
          raw_metadata?: Json
          released_at?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      ai_recommendation_reports: {
        Row: {
          created_by: string | null
          created_by_email: string | null
          generated_at: string
          id: string
          model_used: string
          recommendations: Json
          spend_30d_usd: number
        }
        Insert: {
          created_by?: string | null
          created_by_email?: string | null
          generated_at?: string
          id?: string
          model_used: string
          recommendations?: Json
          spend_30d_usd?: number
        }
        Update: {
          created_by?: string | null
          created_by_email?: string | null
          generated_at?: string
          id?: string
          model_used?: string
          recommendations?: Json
          spend_30d_usd?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_recommendation_reports_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      api_limits: {
        Row: {
          count: number
          endpoint: string
          hour_bucket: string
          property_id: string
        }
        Insert: {
          count?: number
          endpoint: string
          hour_bucket: string
          property_id: string
        }
        Update: {
          count?: number
          endpoint?: string
          hour_bucket?: string
          property_id?: string
        }
        Relationships: []
      }
      app_events: {
        Row: {
          event_type: string
          id: string
          metadata: Json
          property_id: string | null
          ts: string
          user_id: string | null
          user_role: string | null
        }
        Insert: {
          event_type: string
          id?: string
          metadata?: Json
          property_id?: string | null
          ts?: string
          user_id?: string | null
          user_role?: string | null
        }
        Update: {
          event_type?: string
          id?: string
          metadata?: Json
          property_id?: string | null
          ts?: string
          user_id?: string | null
          user_role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          ai_subscriptions: Json
          id: boolean
          subscription_audit_requested_at: string | null
          two_factor_enabled: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ai_subscriptions?: Json
          id?: boolean
          subscription_audit_requested_at?: string | null
          two_factor_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ai_subscriptions?: Json
          id?: boolean
          subscription_audit_requested_at?: string | null
          two_factor_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      applied_migrations: {
        Row: {
          applied_at: string
          description: string | null
          version: string
        }
        Insert: {
          applied_at?: string
          description?: string | null
          version: string
        }
        Update: {
          applied_at?: string
          description?: string | null
          version?: string
        }
        Relationships: []
      }
      attendance_marks: {
        Row: {
          attended: boolean
          date: string
          marked_at: string
          marked_by: string | null
          notes: string | null
          property_id: string
          staff_id: string
        }
        Insert: {
          attended: boolean
          date: string
          marked_at?: string
          marked_by?: string | null
          notes?: string | null
          property_id: string
          staff_id: string
        }
        Update: {
          attended?: boolean
          date?: string
          marked_at?: string
          marked_by?: string | null
          notes?: string | null
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_marks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_marks_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      callout_events: {
        Row: {
          business_date: string
          created_at: string
          id: string
          impacted_assignments: Json
          leave_timing: string | null
          note: string | null
          property_id: string
          reason: string | null
          redistribute_at: string | null
          redistributed_at: string | null
          reported_at: string
          reported_by: string
          reported_by_user_id: string | null
          revert_outcome: Json | null
          revert_reason: string | null
          reverted_at: string | null
          reverted_by_staff_id: string | null
          reverted_by_user_id: string | null
          staff_id: string
          status: string
          updated_at: string
        }
        Insert: {
          business_date: string
          created_at?: string
          id?: string
          impacted_assignments?: Json
          leave_timing?: string | null
          note?: string | null
          property_id: string
          reason?: string | null
          redistribute_at?: string | null
          redistributed_at?: string | null
          reported_at?: string
          reported_by: string
          reported_by_user_id?: string | null
          revert_outcome?: Json | null
          revert_reason?: string | null
          reverted_at?: string | null
          reverted_by_staff_id?: string | null
          reverted_by_user_id?: string | null
          staff_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_date?: string
          created_at?: string
          id?: string
          impacted_assignments?: Json
          leave_timing?: string | null
          note?: string | null
          property_id?: string
          reason?: string | null
          redistribute_at?: string | null
          redistributed_at?: string | null
          reported_at?: string
          reported_by?: string
          reported_by_user_id?: string | null
          revert_outcome?: Json | null
          revert_reason?: string | null
          reverted_at?: string | null
          reverted_by_staff_id?: string | null
          reverted_by_user_id?: string | null
          staff_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "callout_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_events_reverted_by_staff_id_fkey"
            columns: ["reverted_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_events_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      capability_overrides: {
        Row: {
          allowed: boolean
          capability: string
          id: string
          property_id: string
          role: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed: boolean
          capability: string
          id?: string
          property_id: string
          role: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed?: boolean
          capability?: string
          id?: string
          property_id?: string
          role?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capability_overrides_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capability_overrides_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      capex_line_items: {
        Row: {
          amount_cents: number
          capex_project_id: string
          created_at: string
          id: string
          incurred_date: string | null
          label: string
          property_id: string
          source: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_cents?: number
          capex_project_id: string
          created_at?: string
          id?: string
          incurred_date?: string | null
          label: string
          property_id: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          capex_project_id?: string
          created_at?: string
          id?: string
          incurred_date?: string | null
          label?: string
          property_id?: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capex_line_items_capex_project_id_fkey"
            columns: ["capex_project_id"]
            isOneToOne: false
            referencedRelation: "capex_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capex_line_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      capex_projects: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          approved_by_name: string | null
          attachment_path: string | null
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          decided_at: string | null
          decision_notes: string | null
          description: string | null
          estimated_cost_cents: number
          id: string
          name: string
          pct_complete: number
          property_id: string
          quote_cents: number
          request_type: string
          start_date: string | null
          status: string
          submitted_by: string | null
          submitted_by_name: string | null
          target_date: string | null
          updated_at: string
          vendor: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          attachment_path?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          decided_at?: string | null
          decision_notes?: string | null
          description?: string | null
          estimated_cost_cents?: number
          id?: string
          name: string
          pct_complete?: number
          property_id: string
          quote_cents?: number
          request_type?: string
          start_date?: string | null
          status?: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          target_date?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          approved_by_name?: string | null
          attachment_path?: string | null
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          decided_at?: string | null
          decision_notes?: string | null
          description?: string | null
          estimated_cost_cents?: number
          id?: string
          name?: string
          pct_complete?: number
          property_id?: string
          quote_cents?: number
          request_type?: string
          start_date?: string | null
          status?: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          target_date?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "capex_projects_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_items: {
        Row: {
          category: string
          created_at: string
          default_vendor_name: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          suggested_par: number | null
          suggested_unit_cost_cents: number | null
          unit: string
        }
        Insert: {
          category: string
          created_at?: string
          default_vendor_name?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          suggested_par?: number | null
          suggested_unit_cost_cents?: number | null
          unit?: string
        }
        Update: {
          category?: string
          created_at?: string
          default_vendor_name?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          suggested_par?: number | null
          suggested_unit_cost_cents?: number | null
          unit?: string
        }
        Relationships: []
      }
      claude_sessions: {
        Row: {
          branch: string | null
          current_tool: string | null
          cwd: string | null
          last_heartbeat: string
          metadata: Json
          session_id: string
          started_at: string
        }
        Insert: {
          branch?: string | null
          current_tool?: string | null
          cwd?: string | null
          last_heartbeat?: string
          metadata?: Json
          session_id: string
          started_at?: string
        }
        Update: {
          branch?: string | null
          current_tool?: string | null
          cwd?: string | null
          last_heartbeat?: string
          metadata?: Json
          session_id?: string
          started_at?: string
        }
        Relationships: []
      }
      claude_usage_log: {
        Row: {
          cache_read_tokens: number
          cache_write_tokens: number
          cost_micros: number
          id: string
          input_tokens: number
          job_id: string | null
          metadata: Json
          model: string
          output_tokens: number
          property_id: string | null
          source: string
          ts: string
          workload: string
        }
        Insert: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_micros?: number
          id?: string
          input_tokens?: number
          job_id?: string | null
          metadata?: Json
          model: string
          output_tokens?: number
          property_id?: string | null
          source?: string
          ts?: string
          workload: string
        }
        Update: {
          cache_read_tokens?: number
          cache_write_tokens?: number
          cost_micros?: number
          id?: string
          input_tokens?: number
          job_id?: string | null
          metadata?: Json
          model?: string
          output_tokens?: number
          property_id?: string | null
          source?: string
          ts?: string
          workload?: string
        }
        Relationships: [
          {
            foreignKeyName: "claude_usage_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_checklist_items: {
        Row: {
          area: string
          created_at: string
          id: string
          is_critical: boolean
          item_en: string
          item_es: string
          sort_order: number
          template_id: string
        }
        Insert: {
          area: string
          created_at?: string
          id?: string
          is_critical?: boolean
          item_en: string
          item_es: string
          sort_order?: number
          template_id: string
        }
        Update: {
          area?: string
          created_at?: string
          id?: string
          is_critical?: boolean
          item_en?: string
          item_es?: string
          sort_order?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_checklist_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "cleaning_checklist_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_checklist_templates: {
        Row: {
          cleaning_type: string
          created_at: string
          id: string
          is_active: boolean
          is_default: boolean
          name_en: string
          name_es: string
          property_id: string | null
          updated_at: string
        }
        Insert: {
          cleaning_type: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name_en: string
          name_es: string
          property_id?: string | null
          updated_at?: string
        }
        Update: {
          cleaning_type?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name_en?: string
          name_es?: string
          property_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_checklist_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_events: {
        Row: {
          completed_at: string
          created_at: string
          date: string
          day_of_stay_raw: number | null
          day_of_week: number | null
          duration_minutes: number
          feature_set_version: string | null
          flag_reason: string | null
          id: string
          minutes_since_shift_start: number | null
          occupancy_at_start: number | null
          property_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          room_floor: number | null
          room_number: string
          room_type: string
          route_position: number | null
          staff_id: string | null
          staff_name: string
          started_at: string
          status: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day: number | null
          total_checkouts_today: number | null
          total_rooms_assigned_to_hk: number | null
          was_dnd_during_clean: boolean | null
          weather_class: string | null
        }
        Insert: {
          completed_at: string
          created_at?: string
          date: string
          day_of_stay_raw?: number | null
          day_of_week?: number | null
          duration_minutes: number
          feature_set_version?: string | null
          flag_reason?: string | null
          id?: string
          minutes_since_shift_start?: number | null
          occupancy_at_start?: number | null
          property_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          room_floor?: number | null
          room_number: string
          room_type: string
          route_position?: number | null
          staff_id?: string | null
          staff_name: string
          started_at: string
          status?: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day?: number | null
          total_checkouts_today?: number | null
          total_rooms_assigned_to_hk?: number | null
          was_dnd_during_clean?: boolean | null
          weather_class?: string | null
        }
        Update: {
          completed_at?: string
          created_at?: string
          date?: string
          day_of_stay_raw?: number | null
          day_of_week?: number | null
          duration_minutes?: number
          feature_set_version?: string | null
          flag_reason?: string | null
          id?: string
          minutes_since_shift_start?: number | null
          occupancy_at_start?: number | null
          property_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          room_floor?: number | null
          room_number?: string
          room_type?: string
          route_position?: number | null
          staff_id?: string | null
          staff_name?: string
          started_at?: string
          status?: Database["public"]["Enums"]["cleaning_event_status"]
          stayover_day?: number | null
          total_checkouts_today?: number | null
          total_rooms_assigned_to_hk?: number | null
          was_dnd_during_clean?: boolean | null
          weather_class?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleaning_events_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaning_tasks: {
        Row: {
          assignee_id: string | null
          business_date: string
          cleaning_type: string
          completed_at: string | null
          created_at: string
          dedupe_key: string
          due_by: string | null
          estimated_minutes: number | null
          extras: Json
          id: string
          inspected_at: string | null
          last_evaluated_at: string
          notes: string | null
          paused_at: string | null
          priority: string
          property_id: string
          requires_inspection: boolean
          room_number: string
          rule_inputs: Json | null
          rules_fired: Json
          scheduled_at: string | null
          source_engine_run_id: string | null
          source_pms_reservation_id: string | null
          source_property_timezone: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          business_date: string
          cleaning_type: string
          completed_at?: string | null
          created_at?: string
          dedupe_key: string
          due_by?: string | null
          estimated_minutes?: number | null
          extras?: Json
          id?: string
          inspected_at?: string | null
          last_evaluated_at?: string
          notes?: string | null
          paused_at?: string | null
          priority?: string
          property_id: string
          requires_inspection?: boolean
          room_number: string
          rule_inputs?: Json | null
          rules_fired?: Json
          scheduled_at?: string | null
          source_engine_run_id?: string | null
          source_pms_reservation_id?: string | null
          source_property_timezone?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          business_date?: string
          cleaning_type?: string
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string
          due_by?: string | null
          estimated_minutes?: number | null
          extras?: Json
          id?: string
          inspected_at?: string | null
          last_evaluated_at?: string
          notes?: string | null
          paused_at?: string | null
          priority?: string
          property_id?: string
          requires_inspection?: boolean
          room_number?: string
          rule_inputs?: Json | null
          rules_fired?: Json
          scheduled_at?: string | null
          source_engine_run_id?: string | null
          source_pms_reservation_id?: string | null
          source_property_timezone?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_ack_campaigns: {
        Row: {
          created_at: string
          created_by_account: string | null
          id: string
          title: string | null
        }
        Insert: {
          created_at?: string
          created_by_account?: string | null
          id?: string
          title?: string | null
        }
        Update: {
          created_at?: string
          created_by_account?: string | null
          id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comms_ack_campaigns_created_by_account_fkey"
            columns: ["created_by_account"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_acknowledgements: {
        Row: {
          acknowledged_at: string
          id: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          acknowledged_at?: string
          id?: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          acknowledged_at?: string
          id?: string
          message_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_acknowledgements_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_acknowledgements_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_conversations: {
        Row: {
          channel_key: string | null
          created_at: string
          created_by_staff_id: string | null
          dm_key: string | null
          id: string
          kind: string
          last_message_at: string | null
          property_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          channel_key?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          dm_key?: string | null
          id?: string
          kind: string
          last_message_at?: string | null
          property_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          channel_key?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          dm_key?: string | null
          id?: string
          kind?: string
          last_message_at?: string | null
          property_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_conversations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_log_entries: {
        Row: {
          author_staff_id: string | null
          body: string
          category: string | null
          created_at: string
          id: string
          property_id: string
          title: string
          updated_at: string
        }
        Insert: {
          author_staff_id?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          property_id: string
          title: string
          updated_at?: string
        }
        Update: {
          author_staff_id?: string | null
          body?: string
          category?: string | null
          created_at?: string
          id?: string
          property_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_log_entries_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_log_replies: {
        Row: {
          author_staff_id: string | null
          body: string
          created_at: string
          entry_id: string
          id: string
          property_id: string
        }
        Insert: {
          author_staff_id?: string | null
          body: string
          created_at?: string
          entry_id: string
          id?: string
          property_id: string
        }
        Update: {
          author_staff_id?: string | null
          body?: string
          created_at?: string
          entry_id?: string
          id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_log_replies_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "comms_log_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_log_replies_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_members: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          last_read_at: string | null
          property_id: string
          staff_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          last_read_at?: string | null
          property_id: string
          staff_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          last_read_at?: string | null
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_members_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "comms_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_members_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_message_translations: {
        Row: {
          created_at: string
          id: string
          lang: string
          message_id: string
          translated_body: string
        }
        Insert: {
          created_at?: string
          id?: string
          lang: string
          message_id: string
          translated_body: string
        }
        Update: {
          created_at?: string
          id?: string
          lang?: string
          message_id?: string
          translated_body?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_message_translations_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_messages: {
        Row: {
          ack_campaign_id: string | null
          attachment_kind: string | null
          attachment_path: string | null
          body: string
          conversation_id: string
          created_at: string
          handoff_outstanding: string | null
          handoff_shift: string | null
          id: string
          meta: Json
          msg_type: string
          parent_message_id: string | null
          pinned_at: string | null
          pinned_by_staff_id: string | null
          property_id: string
          requires_ack: boolean
          sender_kind: string
          sender_staff_id: string | null
          source_lang: string | null
          voice_duration_ms: number | null
        }
        Insert: {
          ack_campaign_id?: string | null
          attachment_kind?: string | null
          attachment_path?: string | null
          body?: string
          conversation_id: string
          created_at?: string
          handoff_outstanding?: string | null
          handoff_shift?: string | null
          id?: string
          meta?: Json
          msg_type?: string
          parent_message_id?: string | null
          pinned_at?: string | null
          pinned_by_staff_id?: string | null
          property_id: string
          requires_ack?: boolean
          sender_kind?: string
          sender_staff_id?: string | null
          source_lang?: string | null
          voice_duration_ms?: number | null
        }
        Update: {
          ack_campaign_id?: string | null
          attachment_kind?: string | null
          attachment_path?: string | null
          body?: string
          conversation_id?: string
          created_at?: string
          handoff_outstanding?: string | null
          handoff_shift?: string | null
          id?: string
          meta?: Json
          msg_type?: string
          parent_message_id?: string | null
          pinned_at?: string | null
          pinned_by_staff_id?: string | null
          property_id?: string
          requires_ack?: boolean
          sender_kind?: string
          sender_staff_id?: string | null
          source_lang?: string | null
          voice_duration_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "comms_messages_ack_campaign_id_fkey"
            columns: ["ack_campaign_id"]
            isOneToOne: false
            referencedRelation: "comms_ack_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "comms_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_parent_message_id_fkey"
            columns: ["parent_message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_messages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_presence: {
        Row: {
          last_seen_at: string
          property_id: string
          staff_id: string
        }
        Insert: {
          last_seen_at?: string
          property_id: string
          staff_id: string
        }
        Update: {
          last_seen_at?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_presence_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_reactions: {
        Row: {
          created_at: string
          id: string
          kind: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          message_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          message_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_reactions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_tasks: {
        Row: {
          assigned_department: string | null
          assigned_staff_id: string | null
          completed_at: string | null
          completed_by_staff_id: string | null
          created_at: string
          created_by_staff_id: string | null
          due_at: string | null
          id: string
          notes: string | null
          priority: string
          property_id: string
          recurring_instance_date: string | null
          recurring_template_id: string | null
          source_message_id: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_department?: string | null
          assigned_staff_id?: string | null
          completed_at?: string | null
          completed_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id: string
          recurring_instance_date?: string | null
          recurring_template_id?: string | null
          source_message_id?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_department?: string | null
          assigned_staff_id?: string | null
          completed_at?: string | null
          completed_by_staff_id?: string | null
          created_at?: string
          created_by_staff_id?: string | null
          due_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          property_id?: string
          recurring_instance_date?: string | null
          recurring_template_id?: string | null
          source_message_id?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "comms_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comms_tasks_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "comms_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      comms_translation_cache: {
        Row: {
          created_at: string
          id: string
          source_hash: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Insert: {
          created_at?: string
          id?: string
          source_hash: string
          source_text: string
          target_lang: string
          translated_text: string
        }
        Update: {
          created_at?: string
          id?: string
          source_hash?: string
          source_text?: string
          target_lang?: string
          translated_text?: string
        }
        Relationships: []
      }
      complaints: {
        Row: {
          assigned_dept: string | null
          assigned_name: string | null
          assigned_to: string | null
          callback_at: string | null
          callback_done: boolean
          callback_notes: string | null
          callback_nudged_at: string | null
          category: string
          created_at: string
          created_by: string | null
          created_by_name: string | null
          description: string
          escalation_nudged_at: string | null
          guest_contact: string | null
          guest_name: string | null
          id: string
          linked_work_order_id: string | null
          property_id: string
          resolution_notes: string | null
          resolved_at: string | null
          room_number: string | null
          severity: string
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          assigned_dept?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          callback_at?: string | null
          callback_done?: boolean
          callback_notes?: string | null
          callback_nudged_at?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description: string
          escalation_nudged_at?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          id?: string
          linked_work_order_id?: string | null
          property_id: string
          resolution_notes?: string | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_dept?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          callback_at?: string | null
          callback_done?: boolean
          callback_notes?: string | null
          callback_nudged_at?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          description?: string
          escalation_nudged_at?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          id?: string
          linked_work_order_id?: string | null
          property_id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaints_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_linked_work_order_id_fkey"
            columns: ["linked_work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_anomaly_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          ai_phrased: boolean
          baseline_mean: number | null
          baseline_stddev: number | null
          confidence: number | null
          created_at: string
          dedupe_key: string
          detected_by: string
          id: string
          kind: string
          observed_value: number | null
          property_id: string
          reading_id: string | null
          reading_type_id: string
          reason: string
          reason_es: string | null
          score: number | null
          severity: string
          status: string
          updated_at: string
          work_order_id: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          ai_phrased?: boolean
          baseline_mean?: number | null
          baseline_stddev?: number | null
          confidence?: number | null
          created_at?: string
          dedupe_key: string
          detected_by?: string
          id?: string
          kind: string
          observed_value?: number | null
          property_id: string
          reading_id?: string | null
          reading_type_id: string
          reason: string
          reason_es?: string | null
          score?: number | null
          severity?: string
          status?: string
          updated_at?: string
          work_order_id?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          ai_phrased?: boolean
          baseline_mean?: number | null
          baseline_stddev?: number | null
          confidence?: number | null
          created_at?: string
          dedupe_key?: string
          detected_by?: string
          id?: string
          kind?: string
          observed_value?: number | null
          property_id?: string
          reading_id?: string | null
          reading_type_id?: string
          reason?: string
          reason_es?: string | null
          score?: number | null
          severity?: string
          status?: string
          updated_at?: string
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_anomaly_alerts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_anomaly_alerts_reading_id_fkey"
            columns: ["reading_id"]
            isOneToOne: false
            referencedRelation: "compliance_readings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_anomaly_alerts_reading_type_id_fkey"
            columns: ["reading_type_id"]
            isOneToOne: false
            referencedRelation: "compliance_reading_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_anomaly_alerts_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_pm_checks: {
        Row: {
          checked_at: string
          checked_by_name: string | null
          checked_by_staff_id: string | null
          created_at: string
          id: string
          note: string | null
          period_key: string
          photo_path: string | null
          pm_task_id: string
          property_id: string
          status: string
          units_checked: number | null
          updated_at: string
          work_order_id: string | null
        }
        Insert: {
          checked_at?: string
          checked_by_name?: string | null
          checked_by_staff_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          period_key: string
          photo_path?: string | null
          pm_task_id: string
          property_id: string
          status?: string
          units_checked?: number | null
          updated_at?: string
          work_order_id?: string | null
        }
        Update: {
          checked_at?: string
          checked_by_name?: string | null
          checked_by_staff_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          period_key?: string
          photo_path?: string | null
          pm_task_id?: string
          property_id?: string
          status?: string
          units_checked?: number | null
          updated_at?: string
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_pm_checks_checked_by_staff_id_fkey"
            columns: ["checked_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_pm_checks_pm_task_id_fkey"
            columns: ["pm_task_id"]
            isOneToOne: false
            referencedRelation: "compliance_pm_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_pm_checks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_pm_checks_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_pm_tasks: {
        Row: {
          active: boolean
          assigned_department: string
          cadence: string
          category: string
          created_at: string
          equipment_type: string | null
          id: string
          name: string
          property_id: string
          sort_order: number
          template_key: string | null
          unit_count: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          assigned_department?: string
          cadence?: string
          category?: string
          created_at?: string
          equipment_type?: string | null
          id?: string
          name: string
          property_id: string
          sort_order?: number
          template_key?: string | null
          unit_count?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          assigned_department?: string
          cadence?: string
          category?: string
          created_at?: string
          equipment_type?: string | null
          id?: string
          name?: string
          property_id?: string
          sort_order?: number
          template_key?: string | null
          unit_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_pm_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_reading_types: {
        Row: {
          active: boolean
          assigned_department: string
          cadence: string
          category: string
          created_at: string
          id: string
          max_value: number | null
          min_value: number | null
          name: string
          property_id: string
          sort_order: number
          template_key: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          assigned_department?: string
          cadence?: string
          category: string
          created_at?: string
          id?: string
          max_value?: number | null
          min_value?: number | null
          name: string
          property_id: string
          sort_order?: number
          template_key?: string | null
          unit?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          assigned_department?: string
          cadence?: string
          category?: string
          created_at?: string
          id?: string
          max_value?: number | null
          min_value?: number | null
          name?: string
          property_id?: string
          sort_order?: number
          template_key?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_reading_types_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_readings: {
        Row: {
          created_at: string
          id: string
          idempotency_key: string | null
          logged_at: string
          logged_by_name: string | null
          logged_by_staff_id: string | null
          note: string | null
          out_of_range: boolean
          period_key: string
          photo_path: string | null
          property_id: string
          reading_date: string
          reading_type_id: string
          source: string
          text_value: string | null
          unit: string
          updated_at: string
          value: number | null
          work_order_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          idempotency_key?: string | null
          logged_at?: string
          logged_by_name?: string | null
          logged_by_staff_id?: string | null
          note?: string | null
          out_of_range?: boolean
          period_key: string
          photo_path?: string | null
          property_id: string
          reading_date: string
          reading_type_id: string
          source?: string
          text_value?: string | null
          unit?: string
          updated_at?: string
          value?: number | null
          work_order_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          idempotency_key?: string | null
          logged_at?: string
          logged_by_name?: string | null
          logged_by_staff_id?: string | null
          note?: string | null
          out_of_range?: boolean
          period_key?: string
          photo_path?: string | null
          property_id?: string
          reading_date?: string
          reading_type_id?: string
          source?: string
          text_value?: string | null
          unit?: string
          updated_at?: string
          value?: number | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_readings_logged_by_staff_id_fkey"
            columns: ["logged_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_readings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_readings_reading_type_id_fkey"
            columns: ["reading_type_id"]
            isOneToOne: false
            referencedRelation: "compliance_reading_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_readings_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      component_rooms: {
        Row: {
          child_room_numbers: Json
          created_at: string
          id: string
          label: string | null
          parent_room_number: string
          property_id: string
          updated_at: string
        }
        Insert: {
          child_room_numbers?: Json
          created_at?: string
          id?: string
          label?: string | null
          parent_room_number: string
          property_id: string
          updated_at?: string
        }
        Update: {
          child_room_numbers?: Json
          created_at?: string
          id?: string
          label?: string | null
          parent_room_number?: string
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "component_rooms_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_heartbeats: {
        Row: {
          cron_name: string
          last_request_id: string | null
          last_success_at: string
          notes: Json
          updated_at: string
        }
        Insert: {
          cron_name: string
          last_request_id?: string | null
          last_success_at?: string
          notes?: Json
          updated_at?: string
        }
        Update: {
          cron_name?: string
          last_request_id?: string | null
          last_success_at?: string
          notes?: Json
          updated_at?: string
        }
        Relationships: []
      }
      daily_logs: {
        Row: {
          actual_staff: number | null
          adr_cents: number | null
          arrivals: number | null
          avg_turnaround_minutes: number | null
          cancellations: number | null
          channel_mix: Json | null
          channel_source: string | null
          checkouts: number | null
          complaints_count: number | null
          completion_time: string | null
          comps_cents: number | null
          context: Json | null
          created_at: string
          date: string
          day_of_week: number | null
          departures: number | null
          discounts_cents: number | null
          early_checkins: number | null
          extended_stays: number | null
          flow_source: string | null
          fnb_revenue_cents: number | null
          hk_source: string | null
          hourly_wage: number | null
          id: string
          inspections_count: number | null
          inspections_passed: number | null
          inventory_consumed_cents: number | null
          inventory_spend_cents: number | null
          inventory_units_consumed: number | null
          labor_cost: number | null
          labor_cost_per_occupied_room_cents: number | null
          labor_hours: number | null
          labor_saved: number | null
          labor_source: string | null
          laundry_loads: Json | null
          laundry_minutes: number | null
          minutes_per_occupied_room: number | null
          no_shows: number | null
          occupancy_pct: number | null
          occupancy_source: string | null
          occupied: number | null
          other_revenue_cents: number | null
          property_id: string
          public_area_minutes: number | null
          public_areas_due_today: string[] | null
          recommended_staff: number | null
          refunds_cents: number | null
          revenue_source: string | null
          review_avg_score: number | null
          reviews_count: number | null
          revpar_cents: number | null
          room_minutes: number | null
          rooms_available: number | null
          rooms_completed: number | null
          rooms_ooo: number | null
          rooms_revenue_cents: number | null
          rooms_sold: number | null
          seal_version: number
          sealed_at: string | null
          source_completeness: Json | null
          start_time: string | null
          stayovers: number | null
          taxes_cents: number | null
          total_minutes: number | null
          total_revenue_cents: number | null
          two_bed_checkouts: number | null
          updated_at: string
          vips: number | null
          walk_ins: number | null
          work_orders_closed: number | null
          work_orders_open_at_eod: number | null
          work_orders_opened: number | null
        }
        Insert: {
          actual_staff?: number | null
          adr_cents?: number | null
          arrivals?: number | null
          avg_turnaround_minutes?: number | null
          cancellations?: number | null
          channel_mix?: Json | null
          channel_source?: string | null
          checkouts?: number | null
          complaints_count?: number | null
          completion_time?: string | null
          comps_cents?: number | null
          context?: Json | null
          created_at?: string
          date: string
          day_of_week?: number | null
          departures?: number | null
          discounts_cents?: number | null
          early_checkins?: number | null
          extended_stays?: number | null
          flow_source?: string | null
          fnb_revenue_cents?: number | null
          hk_source?: string | null
          hourly_wage?: number | null
          id?: string
          inspections_count?: number | null
          inspections_passed?: number | null
          inventory_consumed_cents?: number | null
          inventory_spend_cents?: number | null
          inventory_units_consumed?: number | null
          labor_cost?: number | null
          labor_cost_per_occupied_room_cents?: number | null
          labor_hours?: number | null
          labor_saved?: number | null
          labor_source?: string | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          minutes_per_occupied_room?: number | null
          no_shows?: number | null
          occupancy_pct?: number | null
          occupancy_source?: string | null
          occupied?: number | null
          other_revenue_cents?: number | null
          property_id: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          refunds_cents?: number | null
          revenue_source?: string | null
          review_avg_score?: number | null
          reviews_count?: number | null
          revpar_cents?: number | null
          room_minutes?: number | null
          rooms_available?: number | null
          rooms_completed?: number | null
          rooms_ooo?: number | null
          rooms_revenue_cents?: number | null
          rooms_sold?: number | null
          seal_version?: number
          sealed_at?: string | null
          source_completeness?: Json | null
          start_time?: string | null
          stayovers?: number | null
          taxes_cents?: number | null
          total_minutes?: number | null
          total_revenue_cents?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
          walk_ins?: number | null
          work_orders_closed?: number | null
          work_orders_open_at_eod?: number | null
          work_orders_opened?: number | null
        }
        Update: {
          actual_staff?: number | null
          adr_cents?: number | null
          arrivals?: number | null
          avg_turnaround_minutes?: number | null
          cancellations?: number | null
          channel_mix?: Json | null
          channel_source?: string | null
          checkouts?: number | null
          complaints_count?: number | null
          completion_time?: string | null
          comps_cents?: number | null
          context?: Json | null
          created_at?: string
          date?: string
          day_of_week?: number | null
          departures?: number | null
          discounts_cents?: number | null
          early_checkins?: number | null
          extended_stays?: number | null
          flow_source?: string | null
          fnb_revenue_cents?: number | null
          hk_source?: string | null
          hourly_wage?: number | null
          id?: string
          inspections_count?: number | null
          inspections_passed?: number | null
          inventory_consumed_cents?: number | null
          inventory_spend_cents?: number | null
          inventory_units_consumed?: number | null
          labor_cost?: number | null
          labor_cost_per_occupied_room_cents?: number | null
          labor_hours?: number | null
          labor_saved?: number | null
          labor_source?: string | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          minutes_per_occupied_room?: number | null
          no_shows?: number | null
          occupancy_pct?: number | null
          occupancy_source?: string | null
          occupied?: number | null
          other_revenue_cents?: number | null
          property_id?: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          refunds_cents?: number | null
          revenue_source?: string | null
          review_avg_score?: number | null
          reviews_count?: number | null
          revpar_cents?: number | null
          room_minutes?: number | null
          rooms_available?: number | null
          rooms_completed?: number | null
          rooms_ooo?: number | null
          rooms_revenue_cents?: number | null
          rooms_sold?: number | null
          seal_version?: number
          sealed_at?: string | null
          source_completeness?: Json | null
          start_time?: string | null
          stayovers?: number | null
          taxes_cents?: number | null
          total_minutes?: number | null
          total_revenue_cents?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
          walk_ins?: number | null
          work_orders_closed?: number | null
          work_orders_open_at_eod?: number | null
          work_orders_opened?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_by_date: {
        Row: {
          arrivals: number | null
          arrivals_guests: number | null
          date: string
          departures: number | null
          departures_guests: number | null
          error_code: string | null
          error_message: string | null
          error_page: string | null
          errored_at: string | null
          in_house: number | null
          in_house_guests: number | null
          property_id: string
          pulled_at: string | null
        }
        Insert: {
          arrivals?: number | null
          arrivals_guests?: number | null
          date: string
          departures?: number | null
          departures_guests?: number | null
          error_code?: string | null
          error_message?: string | null
          error_page?: string | null
          errored_at?: string | null
          in_house?: number | null
          in_house_guests?: number | null
          property_id: string
          pulled_at?: string | null
        }
        Update: {
          arrivals?: number | null
          arrivals_guests?: number | null
          date?: string
          departures?: number | null
          departures_guests?: number | null
          error_code?: string | null
          error_message?: string | null
          error_page?: string | null
          errored_at?: string | null
          in_house?: number | null
          in_house_guests?: number | null
          property_id?: string
          pulled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_by_date_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      deep_clean_config: {
        Row: {
          frequency_days: number
          minutes_per_room: number
          property_id: string
          target_per_week: number
          updated_at: string
        }
        Insert: {
          frequency_days?: number
          minutes_per_room?: number
          property_id: string
          target_per_week?: number
          updated_at?: string
        }
        Update: {
          frequency_days?: number
          minutes_per_room?: number
          property_id?: string
          target_per_week?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deep_clean_config_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      deep_clean_records: {
        Row: {
          assigned_at: string | null
          cleaned_by: string | null
          cleaned_by_team: string[] | null
          completed_at: string | null
          id: string
          last_deep_clean: string | null
          notes: string | null
          property_id: string
          room_number: string
          status: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          cleaned_by?: string | null
          cleaned_by_team?: string[] | null
          completed_at?: string | null
          id?: string
          last_deep_clean?: string | null
          notes?: string | null
          property_id: string
          room_number: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          cleaned_by?: string | null
          cleaned_by_team?: string[] | null
          completed_at?: string | null
          id?: string
          last_deep_clean?: string | null
          notes?: string | null
          property_id?: string
          room_number?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deep_clean_records_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_predictions: {
        Row: {
          date: string
          features_snapshot: Json | null
          id: string
          model_run_id: string
          predicted_at: string
          predicted_headcount_p50: number | null
          predicted_headcount_p80: number | null
          predicted_headcount_p95: number | null
          predicted_minutes_p10: number | null
          predicted_minutes_p25: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75: number | null
          predicted_minutes_p90: number | null
          predicted_minutes_p95: number | null
          property_id: string
        }
        Insert: {
          date: string
          features_snapshot?: Json | null
          id?: string
          model_run_id: string
          predicted_at?: string
          predicted_headcount_p50?: number | null
          predicted_headcount_p80?: number | null
          predicted_headcount_p95?: number | null
          predicted_minutes_p10?: number | null
          predicted_minutes_p25?: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          predicted_minutes_p95?: number | null
          property_id: string
        }
        Update: {
          date?: string
          features_snapshot?: Json | null
          id?: string
          model_run_id?: string
          predicted_at?: string
          predicted_headcount_p50?: number | null
          predicted_headcount_p80?: number | null
          predicted_headcount_p95?: number | null
          predicted_minutes_p10?: number | null
          predicted_minutes_p25?: number | null
          predicted_minutes_p50?: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          predicted_minutes_p95?: number | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "demand_predictions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "demand_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      demand_priors: {
        Row: {
          cohort_key: string
          id: string
          n_hotels_contributing: number
          prior_minutes_per_room_per_day: number
          prior_strength: number
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_room_per_day: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_room_per_day?: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      department_budgets: {
        Row: {
          budget_cents: number
          created_at: string
          department: string
          month_start: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          budget_cents: number
          created_at?: string
          department: string
          month_start: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          budget_cents?: number
          created_at?: string
          department?: string
          month_start?: string
          notes?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_budgets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment: {
        Row: {
          category: string
          created_at: string
          expected_lifetime_years: number | null
          id: string
          install_date: string | null
          last_pm_at: string | null
          location: string | null
          manufacturer: string | null
          model_number: string | null
          name: string
          notes: string | null
          pm_interval_days: number | null
          property_id: string
          purchase_cost: number | null
          replacement_cost: number | null
          serial_number: string | null
          status: string
          updated_at: string
          warranty_expires_at: string | null
          warranty_provider: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          expected_lifetime_years?: number | null
          id?: string
          install_date?: string | null
          last_pm_at?: string | null
          location?: string | null
          manufacturer?: string | null
          model_number?: string | null
          name: string
          notes?: string | null
          pm_interval_days?: number | null
          property_id: string
          purchase_cost?: number | null
          replacement_cost?: number | null
          serial_number?: string | null
          status?: string
          updated_at?: string
          warranty_expires_at?: string | null
          warranty_provider?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          expected_lifetime_years?: number | null
          id?: string
          install_date?: string | null
          last_pm_at?: string | null
          location?: string | null
          manufacturer?: string | null
          model_number?: string | null
          name?: string
          notes?: string | null
          pm_interval_days?: number | null
          property_id?: string
          purchase_cost?: number | null
          replacement_cost?: number | null
          serial_number?: string | null
          status?: string
          updated_at?: string
          warranty_expires_at?: string | null
          warranty_provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      error_logs: {
        Row: {
          context: Json | null
          id: string
          message: string | null
          property_id: string | null
          source: string | null
          stack: string | null
          ts: string
        }
        Insert: {
          context?: Json | null
          id?: string
          message?: string | null
          property_id?: string | null
          source?: string | null
          stack?: string | null
          ts?: string
        }
        Update: {
          context?: Json | null
          id?: string
          message?: string | null
          property_id?: string | null
          source?: string | null
          stack?: string | null
          ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "error_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_cents: number
          category: string
          created_at: string
          description: string | null
          id: string
          incurred_on: string
          metadata: Json
          property_id: string | null
          source: string
          vendor: string | null
        }
        Insert: {
          amount_cents: number
          category: string
          created_at?: string
          description?: string | null
          id?: string
          incurred_on: string
          metadata?: Json
          property_id?: string | null
          source?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          incurred_on?: string
          metadata?: Json
          property_id?: string | null
          source?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_expenses: {
        Row: {
          amount_cents: number
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          department: string
          expense_date: string
          id: string
          invoice_date: string | null
          invoice_number: string | null
          notes: string | null
          property_id: string
          source: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_cents: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          department?: string
          expense_date: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          notes?: string | null
          property_id: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_cents?: number
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          department?: string
          expense_date?: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          notes?: string | null
          property_id?: string
          source?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "financial_expenses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      github_events: {
        Row: {
          branch: string | null
          event_type: string
          id: string
          metadata: Json
          ts: string
        }
        Insert: {
          branch?: string | null
          event_type: string
          id?: string
          metadata?: Json
          ts?: string
        }
        Update: {
          branch?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          ts?: string
        }
        Relationships: []
      }
      guest_requests: {
        Row: {
          assigned_name: string | null
          assigned_to: string | null
          completed_at: string | null
          created_at: string
          id: string
          notes: string | null
          property_id: string
          room_number: string
          status: string
          type: string
        }
        Insert: {
          assigned_name?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          property_id: string
          room_number: string
          status?: string
          type: string
        }
        Update: {
          assigned_name?: string | null
          assigned_to?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          property_id?: string
          room_number?: string
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_requests_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_logs: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          acknowledged_by: string | null
          author: string
          created_at: string
          id: string
          notes: string
          property_id: string
          shift_type: string
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          author: string
          created_at?: string
          id?: string
          notes: string
          property_id: string
          shift_type: string
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          author?: string
          created_at?: string
          id?: string
          notes?: string
          property_id?: string
          shift_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      hk_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string
          assigned_by_user_id: string | null
          cleaning_task_id: string
          created_at: string
          housekeeper_id: string
          id: string
          is_active: boolean
          property_id: string
          queue_order: number
          reason: string | null
          score: number | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string
          assigned_by_user_id?: string | null
          cleaning_task_id: string
          created_at?: string
          housekeeper_id: string
          id?: string
          is_active?: boolean
          property_id: string
          queue_order?: number
          reason?: string | null
          score?: number | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          assigned_by_user_id?: string | null
          cleaning_task_id?: string
          created_at?: string
          housekeeper_id?: string
          id?: string
          is_active?: boolean
          property_id?: string
          queue_order?: number
          reason?: string | null
          score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hk_assignments_cleaning_task_id_fkey"
            columns: ["cleaning_task_id"]
            isOneToOne: false
            referencedRelation: "cleaning_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_assignments_housekeeper_id_fkey"
            columns: ["housekeeper_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      hk_clean_time_standards: {
        Row: {
          base_minutes: number
          cleaning_type: string
          created_at: string
          id: string
          property_id: string
          room_type: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          base_minutes: number
          cleaning_type: string
          created_at?: string
          id?: string
          property_id: string
          room_type?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          base_minutes?: number
          cleaning_type?: string
          created_at?: string
          id?: string
          property_id?: string
          room_type?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hk_clean_time_standards_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hk_clean_time_standards_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      hotel_join_codes: {
        Row: {
          code: string
          code_kind: string
          created_at: string
          created_by: string
          expires_at: string
          hotel_id: string
          id: string
          max_uses: number
          revoked_at: string | null
          role: string | null
          used_count: number
        }
        Insert: {
          code: string
          code_kind?: string
          created_at?: string
          created_by: string
          expires_at: string
          hotel_id: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          role?: string | null
          used_count?: number
        }
        Update: {
          code?: string
          code_kind?: string
          created_at?: string
          created_by?: string
          expires_at?: string
          hotel_id?: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          role?: string | null
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "hotel_join_codes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hotel_join_codes_hotel_id_fkey"
            columns: ["hotel_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeper_audit_log: {
        Row: {
          business_date: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          property_id: string
          room_id: string | null
          room_number: string | null
          staff_id: string
        }
        Insert: {
          business_date: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          property_id: string
          room_id?: string | null
          room_number?: string | null
          staff_id: string
        }
        Update: {
          business_date?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          property_id?: string
          room_id?: string | null
          room_number?: string | null
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeper_audit_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeper_dismissed_notices: {
        Row: {
          dismissed_at: string
          id: string
          notice_id: string
          property_id: string
          staff_id: string
        }
        Insert: {
          dismissed_at?: string
          id?: string
          notice_id: string
          property_id: string
          staff_id: string
        }
        Update: {
          dismissed_at?: string
          id?: string
          notice_id?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeper_dismissed_notices_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "housekeeping_notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "housekeeper_dismissed_notices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      housekeeping_notices: {
        Row: {
          body_en: string
          body_es: string | null
          body_ht: string | null
          body_tl: string | null
          body_vi: string | null
          created_at: string
          expires_at: string | null
          id: string
          pinned: boolean
          posted_at: string
          posted_by_account_id: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          body_en: string
          body_es?: string | null
          body_ht?: string | null
          body_tl?: string | null
          body_vi?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          posted_at?: string
          posted_by_account_id?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          body_en?: string
          body_es?: string | null
          body_ht?: string | null
          body_tl?: string | null
          body_vi?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          posted_at?: string
          posted_by_account_id?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "housekeeping_notices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      idempotency_log: {
        Row: {
          created_at: string
          expires_at: string
          key: string
          property_id: string | null
          response: Json
          route: string
          status_code: number
        }
        Insert: {
          created_at?: string
          expires_at?: string
          key: string
          property_id?: string | null
          response: Json
          route: string
          status_code?: number
        }
        Update: {
          created_at?: string
          expires_at?: string
          key?: string
          property_id?: string | null
          response?: Json
          route?: string
          status_code?: number
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_checklist_items: {
        Row: {
          category: string
          checklist_id: string
          created_at: string
          id: string
          label: string
          label_es: string | null
          order_index: number
          requires_photo_on_fail: boolean
          severity_default: string
        }
        Insert: {
          category: string
          checklist_id: string
          created_at?: string
          id?: string
          label: string
          label_es?: string | null
          order_index?: number
          requires_photo_on_fail?: boolean
          severity_default?: string
        }
        Update: {
          category?: string
          checklist_id?: string
          created_at?: string
          id?: string
          label?: string
          label_es?: string | null
          order_index?: number
          requires_photo_on_fail?: boolean
          severity_default?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspection_checklist_items_checklist_id_fkey"
            columns: ["checklist_id"]
            isOneToOne: false
            referencedRelation: "inspection_checklists"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_checklists: {
        Row: {
          applies_to_cleaning_types: string[]
          applies_to_room_types: string[]
          created_at: string
          id: string
          is_active: boolean
          name: string
          property_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          applies_to_cleaning_types?: string[]
          applies_to_room_types?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          property_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          applies_to_cleaning_types?: string[]
          applies_to_room_types?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          property_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "inspection_checklists_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inspections: {
        Row: {
          checklist_id: string | null
          cleaning_task_id: string | null
          completed_at: string | null
          correction_notice_sent_at: string | null
          created_at: string
          escalated: boolean
          escalation_reason: string | null
          failed_items: Json
          housekeeper_staff_id: string | null
          id: string
          inspector_staff_id: string | null
          notes: string | null
          parent_inspection_id: string | null
          passed_items: Json
          property_id: string
          recheck_inspection_id: string | null
          result: string
          room_id: string | null
          room_number: string
          started_at: string
          updated_at: string
        }
        Insert: {
          checklist_id?: string | null
          cleaning_task_id?: string | null
          completed_at?: string | null
          correction_notice_sent_at?: string | null
          created_at?: string
          escalated?: boolean
          escalation_reason?: string | null
          failed_items?: Json
          housekeeper_staff_id?: string | null
          id?: string
          inspector_staff_id?: string | null
          notes?: string | null
          parent_inspection_id?: string | null
          passed_items?: Json
          property_id: string
          recheck_inspection_id?: string | null
          result?: string
          room_id?: string | null
          room_number: string
          started_at?: string
          updated_at?: string
        }
        Update: {
          checklist_id?: string | null
          cleaning_task_id?: string | null
          completed_at?: string | null
          correction_notice_sent_at?: string | null
          created_at?: string
          escalated?: boolean
          escalation_reason?: string | null
          failed_items?: Json
          housekeeper_staff_id?: string | null
          id?: string
          inspector_staff_id?: string | null
          notes?: string | null
          parent_inspection_id?: string | null
          passed_items?: Json
          property_id?: string
          recheck_inspection_id?: string | null
          result?: string
          room_id?: string | null
          room_number?: string
          started_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspections_checklist_id_fkey"
            columns: ["checklist_id"]
            isOneToOne: false
            referencedRelation: "inspection_checklists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_parent_inspection_id_fkey"
            columns: ["parent_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspections_recheck_inspection_id_fkey"
            columns: ["recheck_inspection_id"]
            isOneToOne: false
            referencedRelation: "inspections"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          case_unit: string | null
          category: string
          created_at: string | null
          created_by: string | null
          current_stock: number
          custom_category_id: string | null
          delivery_baseline_last_ordered_at: string | null
          delivery_baseline_unit_cost: number | null
          delivery_baseline_vendor_name: string | null
          delivery_cache_active: boolean
          id: string
          last_alerted_at: string | null
          last_counted_at: string | null
          last_ordered_at: string | null
          name: string
          notes: string | null
          opening_adjustment_at: string | null
          opening_adjustment_quantity: number | null
          opening_adjustment_request_id: string | null
          opening_adjustment_unit_cost: number | null
          pack_size: number | null
          par_level: number
          property_id: string
          reorder_at: number | null
          reorder_lead_days: number | null
          set_aside: number
          unit: string
          unit_cost: number | null
          updated_at: string
          usage_per_checkout: number | null
          usage_per_stayover: number | null
          vendor_id: string | null
          vendor_name: string | null
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          case_unit?: string | null
          category: string
          created_at?: string | null
          created_by?: string | null
          current_stock?: number
          custom_category_id?: string | null
          delivery_baseline_last_ordered_at?: string | null
          delivery_baseline_unit_cost?: number | null
          delivery_baseline_vendor_name?: string | null
          delivery_cache_active?: boolean
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name: string
          notes?: string | null
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number | null
          opening_adjustment_request_id?: string | null
          opening_adjustment_unit_cost?: number | null
          pack_size?: number | null
          par_level?: number
          property_id: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          set_aside?: number
          unit: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          case_unit?: string | null
          category?: string
          created_at?: string | null
          created_by?: string | null
          current_stock?: number
          custom_category_id?: string | null
          delivery_baseline_last_ordered_at?: string | null
          delivery_baseline_unit_cost?: number | null
          delivery_baseline_vendor_name?: string | null
          delivery_cache_active?: boolean
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name?: string
          notes?: string | null
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number | null
          opening_adjustment_request_id?: string | null
          opening_adjustment_unit_cost?: number | null
          pack_size?: number | null
          par_level?: number
          property_id?: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          set_aside?: number
          unit?: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_custom_category_id_fkey"
            columns: ["custom_category_id"]
            isOneToOne: false
            referencedRelation: "inventory_custom_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_audit_events: {
        Row: {
          action: string
          actor_name: string | null
          actor_user_id: string | null
          after_state: Json | null
          before_state: Json | null
          created_at: string
          dedupe_key: string | null
          details: Json
          entity_id: string | null
          entity_key: string
          entity_type: string
          financial_details: Json
          id: string
          occurred_at: string
          property_id: string
          request_id: string | null
          sequence: number
          source_id: string
          source_table: string
          summary: Json
        }
        Insert: {
          action: string
          actor_name?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          dedupe_key?: string | null
          details?: Json
          entity_id?: string | null
          entity_key: string
          entity_type: string
          financial_details?: Json
          id?: string
          occurred_at: string
          property_id: string
          request_id?: string | null
          sequence?: number
          source_id: string
          source_table: string
          summary?: Json
        }
        Update: {
          action?: string
          actor_name?: string | null
          actor_user_id?: string | null
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          dedupe_key?: string | null
          details?: Json
          entity_id?: string | null
          entity_key?: string
          entity_type?: string
          financial_details?: Json
          id?: string
          occurred_at?: string
          property_id?: string
          request_id?: string | null
          sequence?: number
          source_id?: string
          source_table?: string
          summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "inventory_audit_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_budget_sections: {
        Row: {
          created_at: string
          id: string
          item_ids: string[]
          name: string
          property_id: string
          sort: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_ids?: string[]
          name: string
          property_id: string
          sort?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_ids?: string[]
          name?: string
          property_id?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_budget_sections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_budgets: {
        Row: {
          basis: string
          budget_cents: number
          category: string
          created_at: string
          month_start: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          basis?: string
          budget_cents: number
          category: string
          created_at?: string
          month_start: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          basis?: string
          budget_cents?: number
          category?: string
          created_at?: string
          month_start?: string
          notes?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_budgets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_counts: {
        Row: {
          activity_sequence: number
          count_session_id: string | null
          counted_at: string
          counted_by: string | null
          counted_stock: number
          created_at: string
          estimated_stock: number | null
          id: string
          item_id: string
          item_name: string
          notes: string | null
          property_id: string
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          unit_cost: number | null
          variance: number | null
          variance_value: number | null
        }
        Insert: {
          activity_sequence?: number
          count_session_id?: string | null
          counted_at?: string
          counted_by?: string | null
          counted_stock: number
          created_at?: string
          estimated_stock?: number | null
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          property_id: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Update: {
          activity_sequence?: number
          count_session_id?: string | null
          counted_at?: string
          counted_by?: string | null
          counted_stock?: number
          created_at?: string
          estimated_stock?: number | null
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          property_id?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_custom_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          property_id: string
          sort: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          property_id: string
          sort?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          property_id?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_custom_categories_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_corrections: {
        Row: {
          activity_sequence: number
          corrected_at: string
          corrected_by: string | null
          corrected_by_user_id: string | null
          corrected_item_id: string | null
          corrected_item_name: string | null
          corrected_quantity: number
          corrected_total_cost: number | null
          corrected_unit_cost: number | null
          correction_kind: string
          created_at: string
          id: string
          line_key: string
          original_order_id: string
          previous_item_id: string
          previous_item_name: string
          previous_quantity: number
          previous_total_cost: number | null
          previous_unit_cost: number | null
          prior_correction_id: string | null
          property_id: string
          reason: string
          request_id: string
          stock_effect: Json
        }
        Insert: {
          activity_sequence?: number
          corrected_at: string
          corrected_by?: string | null
          corrected_by_user_id?: string | null
          corrected_item_id?: string | null
          corrected_item_name?: string | null
          corrected_quantity: number
          corrected_total_cost?: number | null
          corrected_unit_cost?: number | null
          correction_kind: string
          created_at?: string
          id?: string
          line_key: string
          original_order_id: string
          previous_item_id: string
          previous_item_name: string
          previous_quantity: number
          previous_total_cost?: number | null
          previous_unit_cost?: number | null
          prior_correction_id?: string | null
          property_id: string
          reason: string
          request_id: string
          stock_effect?: Json
        }
        Update: {
          activity_sequence?: number
          corrected_at?: string
          corrected_by?: string | null
          corrected_by_user_id?: string | null
          corrected_item_id?: string | null
          corrected_item_name?: string | null
          corrected_quantity?: number
          corrected_total_cost?: number | null
          corrected_unit_cost?: number | null
          correction_kind?: string
          created_at?: string
          id?: string
          line_key?: string
          original_order_id?: string
          previous_item_id?: string
          previous_item_name?: string
          previous_quantity?: number
          previous_total_cost?: number | null
          previous_unit_cost?: number | null
          prior_correction_id?: string | null
          property_id?: string
          reason?: string
          request_id?: string
          stock_effect?: Json
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_correction_corrected_item_id_property_i_fkey"
            columns: ["corrected_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_corrected_item_id_property_i_fkey"
            columns: ["corrected_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_original_order_id_property_i_fkey"
            columns: ["original_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_previous_item_id_property_id_fkey"
            columns: ["previous_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_previous_item_id_property_id_fkey"
            columns: ["previous_item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_correction_prior_correction_id_property_fkey"
            columns: ["prior_correction_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_delivery_corrections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_keys: {
        Row: {
          created_at: string
          delivery_key: string
          property_id: string
          request_id: string | null
        }
        Insert: {
          created_at?: string
          delivery_key: string
          property_id: string
          request_id?: string | null
        }
        Update: {
          created_at?: string
          delivery_key?: string
          property_id?: string
          request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_keys_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_delivery_reentries: {
        Row: {
          created_at: string
          delivery_key: string
          id: string
          prior_request_id: string | null
          property_id: string
          reentered_by_user_id: string | null
          replacement_request_id: string
        }
        Insert: {
          created_at?: string
          delivery_key: string
          id?: string
          prior_request_id?: string | null
          property_id: string
          reentered_by_user_id?: string | null
          replacement_request_id: string
        }
        Update: {
          created_at?: string
          delivery_key?: string
          id?: string
          prior_request_id?: string | null
          property_id?: string
          reentered_by_user_id?: string | null
          replacement_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_delivery_key_fkey"
            columns: ["property_id", "delivery_key"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_keys"
            referencedColumns: ["property_id", "delivery_key"]
          },
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_delivery_reentries_property_id_replacement_reque_fkey"
            columns: ["property_id", "replacement_request_id"]
            isOneToOne: false
            referencedRelation: "inventory_write_receipts"
            referencedColumns: ["property_id", "request_id"]
          },
        ]
      }
      inventory_discards: {
        Row: {
          activity_sequence: number
          cost_value: number | null
          created_at: string
          discarded_at: string
          discarded_by: string | null
          expected_stock: number | null
          id: string
          item_id: string
          item_name: string
          notes: string | null
          property_id: string
          quantity: number
          reason: string
          recorded_by_user_id: string | null
          request_id: string | null
          stock_after: number | null
          stock_before: number | null
          unit_cost: number | null
        }
        Insert: {
          activity_sequence?: number
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          expected_stock?: number | null
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          property_id: string
          quantity: number
          reason: string
          recorded_by_user_id?: string | null
          request_id?: string | null
          stock_after?: number | null
          stock_before?: number | null
          unit_cost?: number | null
        }
        Update: {
          activity_sequence?: number
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          expected_stock?: number | null
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          property_id?: string
          quantity?: number
          reason?: string
          recorded_by_user_id?: string | null
          request_id?: string | null
          stock_after?: number | null
          stock_before?: number | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_discards_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_discards_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_discards_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_month_close_purchases: {
        Row: {
          budget_key: string
          budget_section_ids: string[]
          category: string
          close_id: string
          created_at: string
          custom_category_id: string | null
          custom_category_name: string | null
          item_id: string
          item_name: string
          multiple_budget_sections: boolean
          property_id: string
          quantity: number
          received_at: string
          source_order_id: string
          unit_cost_cents: number
          value_cents: number
          vendor_name: string | null
        }
        Insert: {
          budget_key: string
          budget_section_ids?: string[]
          category: string
          close_id: string
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          item_id: string
          item_name: string
          multiple_budget_sections?: boolean
          property_id: string
          quantity: number
          received_at: string
          source_order_id: string
          unit_cost_cents: number
          value_cents: number
          vendor_name?: string | null
        }
        Update: {
          budget_key?: string
          budget_section_ids?: string[]
          category?: string
          close_id?: string
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          item_id?: string
          item_name?: string
          multiple_budget_sections?: boolean
          property_id?: string
          quantity?: number
          received_at?: string
          source_order_id?: string
          unit_cost_cents?: number
          value_cents?: number
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_purchase_source_order_id_property_id_fkey"
            columns: ["source_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_close_id_property_id_fkey"
            columns: ["close_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_closes"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_purchases_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_month_close_snapshot_items: {
        Row: {
          actual_usage_cents: number | null
          archived_at: string | null
          budget_key: string
          budget_section_ids: string[]
          category: string
          counted_at: string | null
          created_at: string
          custom_category_id: string | null
          custom_category_name: string | null
          inventory_count_id: string | null
          inventory_delivery_correction_id: string | null
          inventory_discard_id: string | null
          item_id: string
          item_name: string
          multiple_budget_sections: boolean
          opening_adjustment_at: string | null
          opening_adjustment_quantity: number
          opening_adjustment_unit_cost_cents: number | null
          opening_adjustment_value_cents: number
          physical_unit_cost_cents: number | null
          property_id: string
          purchase_quantity: number | null
          purchase_value_cents: number | null
          quantity: number
          set_aside: number
          snapshot_id: string
          unit_cost_cents: number | null
          valuation_method: string
          value_cents: number | null
        }
        Insert: {
          actual_usage_cents?: number | null
          archived_at?: string | null
          budget_key: string
          budget_section_ids?: string[]
          category: string
          counted_at?: string | null
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          inventory_count_id?: string | null
          inventory_delivery_correction_id?: string | null
          inventory_discard_id?: string | null
          item_id: string
          item_name: string
          multiple_budget_sections?: boolean
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number
          opening_adjustment_unit_cost_cents?: number | null
          opening_adjustment_value_cents?: number
          physical_unit_cost_cents?: number | null
          property_id: string
          purchase_quantity?: number | null
          purchase_value_cents?: number | null
          quantity: number
          set_aside?: number
          snapshot_id: string
          unit_cost_cents?: number | null
          valuation_method: string
          value_cents?: number | null
        }
        Update: {
          actual_usage_cents?: number | null
          archived_at?: string | null
          budget_key?: string
          budget_section_ids?: string[]
          category?: string
          counted_at?: string | null
          created_at?: string
          custom_category_id?: string | null
          custom_category_name?: string | null
          inventory_count_id?: string | null
          inventory_delivery_correction_id?: string | null
          inventory_discard_id?: string | null
          item_id?: string
          item_name?: string
          multiple_budget_sections?: boolean
          opening_adjustment_at?: string | null
          opening_adjustment_quantity?: number
          opening_adjustment_unit_cost_cents?: number | null
          opening_adjustment_value_cents?: number
          physical_unit_cost_cents?: number | null
          property_id?: string
          purchase_quantity?: number | null
          purchase_value_cents?: number | null
          quantity?: number
          set_aside?: number
          snapshot_id?: string
          unit_cost_cents?: number | null
          valuation_method?: string
          value_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_snapsho_inventory_count_id_property__fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapsho_inventory_count_id_property__fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_observed_rate_v"
            referencedColumns: ["newer_count_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_ite_snapshot_id_property_id_fkey"
            columns: ["snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_correction_property_fkey"
            columns: ["inventory_delivery_correction_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_discard_property_fkey"
            columns: ["inventory_discard_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_discards"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_close_snapshot_items_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_month_close_snapshots: {
        Row: {
          captured_at: string
          created_at: string
          id: string
          kind: string
          property_id: string
        }
        Insert: {
          captured_at: string
          created_at?: string
          id?: string
          kind: string
          property_id: string
        }
        Update: {
          captured_at?: string
          created_at?: string
          id?: string
          kind?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_close_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_month_closes: {
        Row: {
          activity_start_at: string
          actual_usage_cents: number | null
          allocation_mode: string | null
          baseline_at: string
          beginning_value_cents: number | null
          budget_comparison_available: boolean
          by_budget_key: Json | null
          by_category: Json | null
          by_item: Json | null
          close_request_id: string | null
          closed_at: string | null
          closed_by: string | null
          closed_by_name: string | null
          confirmed_purchase_cents: number | null
          count_window_start_at: string
          created_at: string
          end_at: string
          ending_snapshot_id: string | null
          ending_value_cents: number | null
          grace_end_at: string
          id: string
          is_partial: boolean
          known_logged_purchase_cents: number
          logged_delivery_count: number
          logged_purchase_cents: number | null
          manual_purchase_cents: number | null
          month_start: string
          month_start_at: string
          notes: string | null
          opened_by: string | null
          opened_by_name: string | null
          opening_adjustment_cents: number
          opening_snapshot_id: string
          property_id: string
          purchase_source: string | null
          quality_flags: Json
          start_request_id: string | null
          status: string
          timezone: string
          uncosted_delivery_count: number
          updated_at: string
          usage_budget_by_key: Json | null
          usage_budget_mode: string | null
          usage_budget_total_cents: number | null
        }
        Insert: {
          activity_start_at: string
          actual_usage_cents?: number | null
          allocation_mode?: string | null
          baseline_at: string
          beginning_value_cents?: number | null
          budget_comparison_available: boolean
          by_budget_key?: Json | null
          by_category?: Json | null
          by_item?: Json | null
          close_request_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_by_name?: string | null
          confirmed_purchase_cents?: number | null
          count_window_start_at: string
          created_at?: string
          end_at: string
          ending_snapshot_id?: string | null
          ending_value_cents?: number | null
          grace_end_at: string
          id?: string
          is_partial: boolean
          known_logged_purchase_cents?: number
          logged_delivery_count?: number
          logged_purchase_cents?: number | null
          manual_purchase_cents?: number | null
          month_start: string
          month_start_at: string
          notes?: string | null
          opened_by?: string | null
          opened_by_name?: string | null
          opening_adjustment_cents?: number
          opening_snapshot_id: string
          property_id: string
          purchase_source?: string | null
          quality_flags?: Json
          start_request_id?: string | null
          status?: string
          timezone: string
          uncosted_delivery_count?: number
          updated_at?: string
          usage_budget_by_key?: Json | null
          usage_budget_mode?: string | null
          usage_budget_total_cents?: number | null
        }
        Update: {
          activity_start_at?: string
          actual_usage_cents?: number | null
          allocation_mode?: string | null
          baseline_at?: string
          beginning_value_cents?: number | null
          budget_comparison_available?: boolean
          by_budget_key?: Json | null
          by_category?: Json | null
          by_item?: Json | null
          close_request_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          closed_by_name?: string | null
          confirmed_purchase_cents?: number | null
          count_window_start_at?: string
          created_at?: string
          end_at?: string
          ending_snapshot_id?: string | null
          ending_value_cents?: number | null
          grace_end_at?: string
          id?: string
          is_partial?: boolean
          known_logged_purchase_cents?: number
          logged_delivery_count?: number
          logged_purchase_cents?: number | null
          manual_purchase_cents?: number | null
          month_start?: string
          month_start_at?: string
          notes?: string | null
          opened_by?: string | null
          opened_by_name?: string | null
          opening_adjustment_cents?: number
          opening_snapshot_id?: string
          property_id?: string
          purchase_source?: string | null
          quality_flags?: Json
          start_request_id?: string | null
          status?: string
          timezone?: string
          uncosted_delivery_count?: number
          updated_at?: string
          usage_budget_by_key?: Json | null
          usage_budget_mode?: string | null
          usage_budget_total_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_month_closes_ending_snapshot_id_property_id_fkey"
            columns: ["ending_snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_closes_opening_snapshot_id_property_id_fkey"
            columns: ["opening_snapshot_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_month_close_snapshots"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_month_closes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_opening_adjustments: {
        Row: {
          actor_id: string | null
          actor_name: string | null
          created_at: string
          effective_at: string
          id: string
          item_id: string
          property_id: string
          quantity: number
          reason: string
          request_id: string
          stock_after: number
          stock_before: number
          unit_cost_cents: number
          value_cents: number
        }
        Insert: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          effective_at: string
          id?: string
          item_id: string
          property_id: string
          quantity: number
          reason?: string
          request_id: string
          stock_after: number
          stock_before: number
          unit_cost_cents: number
          value_cents: number
        }
        Update: {
          actor_id?: string | null
          actor_name?: string | null
          created_at?: string
          effective_at?: string
          id?: string
          item_id?: string
          property_id?: string
          quantity?: number
          reason?: string
          request_id?: string
          stock_after?: number
          stock_before?: number
          unit_cost_cents?: number
          value_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "inventory_opening_adjustments_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_opening_adjustments_item_id_property_id_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
        ]
      }
      inventory_orders: {
        Row: {
          activity_sequence: number
          correction_event_id: string | null
          corrects_order_id: string | null
          created_at: string
          entry_kind: string
          id: string
          item_id: string
          item_name: string
          notes: string | null
          ordered_at: string | null
          property_id: string
          quantity: number
          quantity_cases: number | null
          received_at: string
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          request_id: string | null
          total_cost: number | null
          unit_cost: number | null
          vendor_name: string | null
        }
        Insert: {
          activity_sequence?: number
          correction_event_id?: string | null
          corrects_order_id?: string | null
          created_at?: string
          entry_kind?: string
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          ordered_at?: string | null
          property_id: string
          quantity: number
          quantity_cases?: number | null
          received_at?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          request_id?: string | null
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Update: {
          activity_sequence?: number
          correction_event_id?: string | null
          corrects_order_id?: string | null
          created_at?: string
          entry_kind?: string
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          ordered_at?: string | null
          property_id?: string
          quantity?: number
          quantity_cases?: number | null
          received_at?: string
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          request_id?: string | null
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_orders_correction_event_property_fkey"
            columns: ["correction_event_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_delivery_corrections"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_corrects_order_property_fkey"
            columns: ["corrects_order_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_orders"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_rate_predictions: {
        Row: {
          id: string
          is_shadow: boolean
          item_id: string
          item_name: string
          model_run_id: string
          predicted_at: string
          predicted_current_stock: number | null
          predicted_daily_rate: number
          predicted_daily_rate_p10: number | null
          predicted_daily_rate_p25: number | null
          predicted_daily_rate_p50: number | null
          predicted_daily_rate_p75: number | null
          predicted_daily_rate_p90: number | null
          predicted_for_date: string
          property_id: string
        }
        Insert: {
          id?: string
          is_shadow?: boolean
          item_id: string
          item_name: string
          model_run_id: string
          predicted_at?: string
          predicted_current_stock?: number | null
          predicted_daily_rate: number
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date: string
          property_id: string
        }
        Update: {
          id?: string
          is_shadow?: boolean
          item_id?: string
          item_name?: string
          model_run_id?: string
          predicted_at?: string
          predicted_current_stock?: number | null
          predicted_daily_rate?: number
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_rate_predictions_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_model_property_item_fkey"
            columns: ["model_run_id", "property_id", "item_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id", "property_id", "item_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_rate_priors: {
        Row: {
          cohort_key: string
          id: string
          item_canonical_name: string
          n_hotels: number
          n_hotels_contributing: number
          prior_rate_per_room_per_day: number
          prior_strength: number
          rate_per_checkout_eq: number | null
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          item_canonical_name: string
          n_hotels?: number
          n_hotels_contributing?: number
          prior_rate_per_room_per_day: number
          prior_strength?: number
          rate_per_checkout_eq?: number | null
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          item_canonical_name?: string
          n_hotels?: number
          n_hotels_contributing?: number
          prior_rate_per_room_per_day?: number
          prior_strength?: number
          rate_per_checkout_eq?: number | null
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      inventory_reconciliations: {
        Row: {
          created_at: string
          discards_since_last: number
          id: string
          item_id: string
          item_name: string
          notes: string | null
          physical_count: number
          property_id: string
          reconciled_at: string
          reconciled_by: string | null
          recorded_by_name: string | null
          recorded_by_user_id: string | null
          system_estimate: number
          unaccounted_variance: number
          unaccounted_variance_value: number | null
          unit_cost: number | null
        }
        Insert: {
          created_at?: string
          discards_since_last?: number
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          physical_count: number
          property_id: string
          reconciled_at?: string
          reconciled_by?: string | null
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          system_estimate: number
          unaccounted_variance: number
          unaccounted_variance_value?: number | null
          unit_cost?: number | null
        }
        Update: {
          created_at?: string
          discards_since_last?: number
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          physical_count?: number
          property_id?: string
          reconciled_at?: string
          reconciled_by?: string | null
          recorded_by_name?: string | null
          recorded_by_user_id?: string | null
          system_estimate?: number
          unaccounted_variance?: number
          unaccounted_variance_value?: number | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_reconciliations_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_reconciliations_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_reconciliations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_write_receipts: {
        Row: {
          created_at: string
          operation: string
          payload: Json
          property_id: string
          request_id: string
          result: Json | null
        }
        Insert: {
          created_at?: string
          operation: string
          payload: Json
          property_id: string
          request_id: string
          result?: Json | null
        }
        Update: {
          created_at?: string
          operation?: string
          payload?: Json
          property_id?: string
          request_id?: string
          result?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_write_receipts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      join_requests: {
        Row: {
          account_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          department: string
          id: string
          language: string
          name: string
          phone: string | null
          property_id: string
          status: string
        }
        Insert: {
          account_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          department: string
          id?: string
          language?: string
          name: string
          phone?: string | null
          property_id: string
          status?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          department?: string
          id?: string
          language?: string
          name?: string
          phone?: string | null
          property_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_requests_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_articles: {
        Row: {
          body: string
          category: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          property_id: string
          title: string
          updated_at: string
          updated_by: string | null
          updated_by_name: string | null
          visibility: string
        }
        Insert: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id: string
          title: string
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
          visibility?: string
        }
        Update: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          property_id?: string
          title?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_name?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_articles_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          article_id: string | null
          char_count: number | null
          chunk_index: number
          content: string
          created_at: string
          document_id: string | null
          embedding: string | null
          id: string
          property_id: string
          section: string | null
          source_type: string
          visibility: string
          visible_dept: string | null
        }
        Insert: {
          article_id?: string | null
          char_count?: number | null
          chunk_index: number
          content: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          property_id: string
          section?: string | null
          source_type: string
          visibility?: string
          visible_dept?: string | null
        }
        Update: {
          article_id?: string | null
          char_count?: number | null
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string | null
          embedding?: string | null
          id?: string
          property_id?: string
          section?: string | null
          source_type?: string
          visibility?: string
          visible_dept?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "knowledge_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "knowledge_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_contacts: {
        Row: {
          address: string | null
          category: string | null
          city_state_zip: string | null
          company: string | null
          created_at: string
          created_by: string | null
          created_by_name: string | null
          email: string | null
          hours: string | null
          id: string
          local_category: string | null
          name: string
          notes: string | null
          phone: string | null
          property_id: string
        }
        Insert: {
          address?: string | null
          category?: string | null
          city_state_zip?: string | null
          company?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          email?: string | null
          hours?: string | null
          id?: string
          local_category?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          property_id: string
        }
        Update: {
          address?: string | null
          category?: string | null
          city_state_zip?: string | null
          company?: string | null
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          email?: string | null
          hours?: string | null
          id?: string
          local_category?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_contacts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_documents: {
        Row: {
          created_at: string
          extract_error: string | null
          extracted_at: string | null
          extracted_text: string | null
          extraction_status: string
          file_path: string
          folder_id: string | null
          id: string
          mime_type: string | null
          property_id: string
          size_bytes: number | null
          title: string
          uploaded_by: string | null
          uploaded_by_name: string | null
          visibility: string
          visible_dept: string | null
        }
        Insert: {
          created_at?: string
          extract_error?: string | null
          extracted_at?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_path: string
          folder_id?: string | null
          id?: string
          mime_type?: string | null
          property_id: string
          size_bytes?: number | null
          title: string
          uploaded_by?: string | null
          uploaded_by_name?: string | null
          visibility?: string
          visible_dept?: string | null
        }
        Update: {
          created_at?: string
          extract_error?: string | null
          extracted_at?: string | null
          extracted_text?: string | null
          extraction_status?: string
          file_path?: string
          folder_id?: string | null
          id?: string
          mime_type?: string | null
          property_id?: string
          size_bytes?: number | null
          title?: string
          uploaded_by?: string | null
          uploaded_by_name?: string | null
          visibility?: string
          visible_dept?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_documents_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "knowledge_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_events: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_name: string | null
          end_date: string | null
          event_date: string
          id: string
          notes: string | null
          property_id: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          end_date?: string | null
          event_date: string
          id?: string
          notes?: string | null
          property_id: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          end_date?: string | null
          event_date?: string
          id?: string
          notes?: string | null
          property_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_folders: {
        Row: {
          created_at: string
          created_by: string | null
          created_by_name: string | null
          id: string
          name: string
          parent_id: string | null
          property_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          name: string
          parent_id?: string | null
          property_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          created_by_name?: string | null
          id?: string
          name?: string
          parent_id?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "knowledge_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_folders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      labor_wage_settings: {
        Row: {
          created_at: string
          hourly_wage_cents: number
          id: string
          property_id: string
          role: string | null
          scope: string
          staff_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          hourly_wage_cents: number
          id?: string
          property_id: string
          role?: string | null
          scope: string
          staff_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          hourly_wage_cents?: number
          id?: string
          property_id?: string
          role?: string | null
          scope?: string
          staff_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "labor_wage_settings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "labor_wage_settings_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      laundry_completion: {
        Row: {
          completed_area_ids: string[]
          completed_load_categories: string[]
          property_id: string
          shift_date: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          completed_area_ids?: string[]
          completed_load_categories?: string[]
          property_id: string
          shift_date: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          completed_area_ids?: string[]
          completed_load_categories?: string[]
          property_id?: string
          shift_date?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "laundry_completion_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "laundry_completion_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      laundry_config: {
        Row: {
          created_at: string
          id: string
          minutes_per_load: number
          name: string
          property_id: string
          room_equivs_per_load: number
          stayover_factor: number
          two_bed_multiplier: number
          units_per_checkout: number
        }
        Insert: {
          created_at?: string
          id?: string
          minutes_per_load?: number
          name: string
          property_id: string
          room_equivs_per_load?: number
          stayover_factor?: number
          two_bed_multiplier?: number
          units_per_checkout?: number
        }
        Update: {
          created_at?: string
          id?: string
          minutes_per_load?: number
          name?: string
          property_id?: string
          room_equivs_per_load?: number
          stayover_factor?: number
          two_bed_multiplier?: number
          units_per_checkout?: number
        }
        Relationships: [
          {
            foreignKeyName: "laundry_config_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      local_worktrees: {
        Row: {
          branch: string | null
          commits_ahead: number
          commits_behind: number
          dirty_files: number
          head_committed_at: string | null
          head_message: string | null
          host: string
          last_seen: string
          name: string
        }
        Insert: {
          branch?: string | null
          commits_ahead?: number
          commits_behind?: number
          dirty_files?: number
          head_committed_at?: string | null
          head_message?: string | null
          host?: string
          last_seen?: string
          name: string
        }
        Update: {
          branch?: string | null
          commits_ahead?: number
          commits_behind?: number
          dirty_files?: number
          head_committed_at?: string | null
          head_message?: string | null
          host?: string
          last_seen?: string
          name?: string
        }
        Relationships: []
      }
      lost_and_found_items: {
        Row: {
          category: string | null
          claimed_at: string | null
          created_at: string
          created_by_account_id: string | null
          found_by: string | null
          found_by_staff_id: string | null
          guest_contact: string | null
          guest_name: string | null
          hold_until: string | null
          id: string
          item_description: string
          location: string | null
          matched_item_id: string | null
          notes: string | null
          occurred_at: string | null
          photo_path: string | null
          property_id: string
          reported_by: string | null
          returned_at: string | null
          room_number: string | null
          shipping_info: Json | null
          source: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_account_id?: string | null
          found_by?: string | null
          found_by_staff_id?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          hold_until?: string | null
          id?: string
          item_description: string
          location?: string | null
          matched_item_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          photo_path?: string | null
          property_id: string
          reported_by?: string | null
          returned_at?: string | null
          room_number?: string | null
          shipping_info?: Json | null
          source?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          claimed_at?: string | null
          created_at?: string
          created_by_account_id?: string | null
          found_by?: string | null
          found_by_staff_id?: string | null
          guest_contact?: string | null
          guest_name?: string | null
          hold_until?: string | null
          id?: string
          item_description?: string
          location?: string | null
          matched_item_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          photo_path?: string | null
          property_id?: string
          reported_by?: string | null
          returned_at?: string | null
          room_number?: string | null
          shipping_info?: Json | null
          source?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_and_found_items_matched_item_id_fkey"
            columns: ["matched_item_id"]
            isOneToOne: false
            referencedRelation: "lost_and_found_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_and_found_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      manager_notifications: {
        Row: {
          created_at: string
          id: string
          message: string
          property_id: string
          read: boolean
          replacement_name: string | null
          shift_date: string
          staff_name: string | null
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          property_id: string
          read?: boolean
          replacement_name?: string | null
          shift_date: string
          staff_name?: string | null
          type: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          property_id?: string
          read?: boolean
          replacement_name?: string | null
          shift_date?: string
          staff_name?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_notifications_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      manager_room_notes: {
        Row: {
          business_date: string
          created_at: string
          expires_at: string | null
          id: string
          note_lang: string | null
          note_text: string
          posted_at: string
          posted_by_account_id: string | null
          property_id: string
          room_number: string
        }
        Insert: {
          business_date: string
          created_at?: string
          expires_at?: string | null
          id?: string
          note_lang?: string | null
          note_text: string
          posted_at?: string
          posted_by_account_id?: string | null
          property_id: string
          room_number: string
        }
        Update: {
          business_date?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          note_lang?: string | null
          note_text?: string
          posted_at?: string
          posted_by_account_id?: string | null
          property_id?: string
          room_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_room_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mapper_job_watchers: {
        Row: {
          admin_user_id: string
          job_id: string
          last_seen_at: string
        }
        Insert: {
          admin_user_id: string
          job_id: string
          last_seen_at?: string
        }
        Update: {
          admin_user_id?: string
          job_id?: string
          last_seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mapper_job_watchers_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapper_job_watchers_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapper_takeover_sessions: {
        Row: {
          admin_user_id: string | null
          applied_command_seq: number
          command: string | null
          command_coordinate: Json | null
          command_frame_seq: number | null
          command_note: string | null
          command_seq: number
          created_at: string
          ended_at: string | null
          ended_reason: string | null
          frame_seq: number
          id: string
          job_id: string
          requested_at: string
          started_at: string | null
          status: string
          target_key: string | null
          viewport_h: number
          viewport_w: number
        }
        Insert: {
          admin_user_id?: string | null
          applied_command_seq?: number
          command?: string | null
          command_coordinate?: Json | null
          command_frame_seq?: number | null
          command_note?: string | null
          command_seq?: number
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          frame_seq?: number
          id?: string
          job_id: string
          requested_at?: string
          started_at?: string | null
          status?: string
          target_key?: string | null
          viewport_h?: number
          viewport_w?: number
        }
        Update: {
          admin_user_id?: string | null
          applied_command_seq?: number
          command?: string | null
          command_coordinate?: Json | null
          command_frame_seq?: number | null
          command_note?: string | null
          command_seq?: number
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          frame_seq?: number
          id?: string
          job_id?: string
          requested_at?: string
          started_at?: string | null
          status?: string
          target_key?: string | null
          viewport_h?: number
          viewport_w?: number
        }
        Relationships: [
          {
            foreignKeyName: "mapper_takeover_sessions_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapper_takeover_sessions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_feed_captures: {
        Row: {
          created_at: string
          feed_key: string
          id: string
          job_id: string
          pms_family: string
          property_id: string
          screenshot_path: string
        }
        Insert: {
          created_at?: string
          feed_key: string
          id?: string
          job_id: string
          pms_family: string
          property_id: string
          screenshot_path: string
        }
        Update: {
          created_at?: string
          feed_key?: string
          id?: string
          job_id?: string
          pms_family?: string
          property_id?: string
          screenshot_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "mapping_feed_captures_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_feed_captures_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_help_requests: {
        Row: {
          action_type: string | null
          admin_user_id: string | null
          answered_at: string | null
          created_at: string
          expires_at: string
          id: string
          job_id: string
          question: string
          response_coordinate: Json | null
          response_text: string | null
          screenshot_storage_path: string
          scroll_x: number
          scroll_y: number
          status: string
          suggested_paths: Json | null
          target_key: string
          viewport_h: number
          viewport_w: number
          what_ive_tried: Json | null
        }
        Insert: {
          action_type?: string | null
          admin_user_id?: string | null
          answered_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          job_id: string
          question: string
          response_coordinate?: Json | null
          response_text?: string | null
          screenshot_storage_path: string
          scroll_x?: number
          scroll_y?: number
          status?: string
          suggested_paths?: Json | null
          target_key: string
          viewport_h?: number
          viewport_w?: number
          what_ive_tried?: Json | null
        }
        Update: {
          action_type?: string | null
          admin_user_id?: string | null
          answered_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          job_id?: string
          question?: string
          response_coordinate?: Json | null
          response_text?: string | null
          screenshot_storage_path?: string
          scroll_x?: number
          scroll_y?: number
          status?: string
          suggested_paths?: Json | null
          target_key?: string
          viewport_h?: number
          viewport_w?: number
          what_ive_tried?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "mapping_help_requests_admin_user_id_fkey"
            columns: ["admin_user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_help_requests_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_notes: {
        Row: {
          consumed_at: string | null
          created_at: string
          id: string
          job_id: string
          note: string
          property_id: string | null
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          id?: string
          job_id: string
          note: string
          property_id?: string | null
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          id?: string
          job_id?: string
          note?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mapping_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mapping_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mapping_takeover_steps: {
        Row: {
          applied_at: string | null
          created_at: string
          id: string
          job_id: string
          seq: number
          status: string
          step: Json
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          id?: string
          job_id: string
          seq: number
          status?: string
          step: Json
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          id?: string
          job_id?: string
          seq?: number
          status?: string
          step?: Json
        }
        Relationships: [
          {
            foreignKeyName: "mapping_takeover_steps_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "workflow_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      mfa_verified_sessions: {
        Row: {
          session_id: string
          user_id: string
          verified_at: string
          verified_from_ip: string | null
          verified_from_ua: string | null
        }
        Insert: {
          session_id: string
          user_id: string
          verified_at?: string
          verified_from_ip?: string | null
          verified_from_ua?: string | null
        }
        Update: {
          session_id?: string
          user_id?: string
          verified_at?: string
          verified_from_ip?: string | null
          verified_from_ua?: string | null
        }
        Relationships: []
      }
      ml_feature_flags: {
        Row: {
          demand_layer_enabled: boolean
          inventory_layer_enabled: boolean
          optimizer_enabled: boolean
          predictions_enabled: boolean
          property_id: string
          shadow_mode_enabled: boolean
          supply_layer_enabled: boolean
          target_completion_prob: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          demand_layer_enabled?: boolean
          inventory_layer_enabled?: boolean
          optimizer_enabled?: boolean
          predictions_enabled?: boolean
          property_id: string
          shadow_mode_enabled?: boolean
          supply_layer_enabled?: boolean
          target_completion_prob?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          demand_layer_enabled?: boolean
          inventory_layer_enabled?: boolean
          optimizer_enabled?: boolean
          predictions_enabled?: boolean
          property_id?: string
          shadow_mode_enabled?: boolean
          supply_layer_enabled?: boolean
          target_completion_prob?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ml_feature_flags_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      model_runs: {
        Row: {
          activated_at: string | null
          algorithm: string
          auto_fill_enabled: boolean
          auto_fill_enabled_at: string | null
          baseline_mae: number | null
          beats_baseline_pct: number | null
          cold_start: boolean
          consecutive_passing_runs: number
          created_at: string
          deactivated_at: string | null
          deactivation_reason: string | null
          feature_set_version: string
          hyperparameters: Json | null
          id: string
          is_active: boolean
          is_cold_start: boolean
          is_shadow: boolean
          item_id: string | null
          layer: string
          model_blob_path: string | null
          model_version: string
          notes: string | null
          posterior_params: Json | null
          property_id: string
          shadow_evaluation_mae: number | null
          shadow_promoted_at: string | null
          shadow_started_at: string | null
          trained_at: string
          training_mae: number | null
          training_row_count: number
          validation_holdout_n: number | null
          validation_mae: number | null
        }
        Insert: {
          activated_at?: string | null
          algorithm: string
          auto_fill_enabled?: boolean
          auto_fill_enabled_at?: string | null
          baseline_mae?: number | null
          beats_baseline_pct?: number | null
          cold_start?: boolean
          consecutive_passing_runs?: number
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          feature_set_version?: string
          hyperparameters?: Json | null
          id?: string
          is_active?: boolean
          is_cold_start?: boolean
          is_shadow?: boolean
          item_id?: string | null
          layer: string
          model_blob_path?: string | null
          model_version: string
          notes?: string | null
          posterior_params?: Json | null
          property_id: string
          shadow_evaluation_mae?: number | null
          shadow_promoted_at?: string | null
          shadow_started_at?: string | null
          trained_at?: string
          training_mae?: number | null
          training_row_count: number
          validation_holdout_n?: number | null
          validation_mae?: number | null
        }
        Update: {
          activated_at?: string | null
          algorithm?: string
          auto_fill_enabled?: boolean
          auto_fill_enabled_at?: string | null
          baseline_mae?: number | null
          beats_baseline_pct?: number | null
          cold_start?: boolean
          consecutive_passing_runs?: number
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          feature_set_version?: string
          hyperparameters?: Json | null
          id?: string
          is_active?: boolean
          is_cold_start?: boolean
          is_shadow?: boolean
          item_id?: string | null
          layer?: string
          model_blob_path?: string | null
          model_version?: string
          notes?: string | null
          posterior_params?: Json | null
          property_id?: string
          shadow_evaluation_mae?: number | null
          shadow_promoted_at?: string | null
          shadow_started_at?: string | null
          trained_at?: string
          training_mae?: number | null
          training_row_count?: number
          validation_holdout_n?: number | null
          validation_mae?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "model_runs_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "model_runs_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "model_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      offline_action_replays: {
        Row: {
          action_id: string
          created_at: string
          endpoint: string
          property_id: string
          result_payload: Json
          staff_id: string
        }
        Insert: {
          action_id: string
          created_at?: string
          endpoint: string
          property_id: string
          result_payload?: Json
          staff_id: string
        }
        Update: {
          action_id?: string
          created_at?: string
          endpoint?: string
          property_id?: string
          result_payload?: Json
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offline_action_replays_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          force_remap: boolean
          id: string
          pms_type: string
          progress_pct: number
          property_id: string
          recipe_id: string | null
          result: Json | null
          started_at: string | null
          status: string
          step: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          force_remap?: boolean
          id?: string
          pms_type: string
          progress_pct?: number
          property_id: string
          recipe_id?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          force_remap?: boolean
          id?: string
          pms_type?: string
          progress_pct?: number
          property_id?: string
          recipe_id?: string | null
          result?: Json | null
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      optimizer_results: {
        Row: {
          achieved_completion_probability: number | null
          assignment_plan: Json | null
          completion_probability_curve: Json
          date: string
          id: string
          inputs_snapshot: Json
          monte_carlo_draws: number
          property_id: string
          ran_at: string
          recommended_headcount: number
          sensitivity_analysis: Json | null
          target_completion_probability: number
        }
        Insert: {
          achieved_completion_probability?: number | null
          assignment_plan?: Json | null
          completion_probability_curve: Json
          date: string
          id?: string
          inputs_snapshot: Json
          monte_carlo_draws?: number
          property_id: string
          ran_at?: string
          recommended_headcount: number
          sensitivity_analysis?: Json | null
          target_completion_probability?: number
        }
        Update: {
          achieved_completion_probability?: number | null
          assignment_plan?: Json | null
          completion_probability_curve?: Json
          date?: string
          id?: string
          inputs_snapshot?: Json
          monte_carlo_draws?: number
          property_id?: string
          ran_at?: string
          recommended_headcount?: number
          sensitivity_analysis?: Json | null
          target_completion_probability?: number
        }
        Relationships: [
          {
            foreignKeyName: "optimizer_results_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_epochs: {
        Row: {
          organization_id: string
          updated_at: string
          version: number
        }
        Insert: {
          organization_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          organization_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_epochs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_events: {
        Row: {
          actor_account_id: string | null
          actor_kind: string
          after_state: Json | null
          before_state: Json | null
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string | null
          request_id: string | null
          support_session_id: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          actor_account_id?: string | null
          actor_kind?: string
          after_state?: Json | null
          before_state?: Json | null
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          request_id?: string | null
          support_session_id?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          actor_account_id?: string | null
          actor_kind?: string
          after_state?: Json | null
          before_state?: Json | null
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string | null
          request_id?: string | null
          support_session_id?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: []
      }
      organization_access_grants: {
        Row: {
          access_profile: string
          created_at: string
          expires_at: string | null
          granted_by_account_id: string | null
          id: string
          membership_id: string
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          revocation_reason: string | null
          revoked_at: string | null
          revoked_by_account_id: string | null
          scope_type: string
          source: string
          starts_at: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          access_profile: string
          created_at?: string
          expires_at?: string | null
          granted_by_account_id?: string | null
          id?: string
          membership_id: string
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type: string
          source?: string
          starts_at?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          access_profile?: string
          created_at?: string
          expires_at?: string | null
          granted_by_account_id?: string | null
          id?: string
          membership_id?: string
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revocation_reason?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type?: string
          source?: string
          starts_at?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_grants_granted_by_account_id_fkey"
            columns: ["granted_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_access_grants_membership_scope_fkey"
            columns: ["membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_grants_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_grants_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_access_grants_revoked_by_account_id_fkey"
            columns: ["revoked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_access_requests: {
        Row: {
          id: string
          membership_id: string
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          reason: string
          requested_access_profile: string
          requested_at: string
          resulting_grant_id: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by_account_id: string | null
          scope_type: string
          status: string
          updated_at: string
        }
        Insert: {
          id?: string
          membership_id: string
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          reason: string
          requested_access_profile: string
          requested_at?: string
          resulting_grant_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_account_id?: string | null
          scope_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          id?: string
          membership_id?: string
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          reason?: string
          requested_access_profile?: string
          requested_at?: string
          resulting_grant_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by_account_id?: string | null
          scope_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_access_requests_membership_scope_fkey"
            columns: ["membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_requests_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_access_requests_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_access_requests_resulting_grant_id_fkey"
            columns: ["resulting_grant_id"]
            isOneToOne: false
            referencedRelation: "organization_access_grants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_access_requests_reviewed_by_account_id_fkey"
            columns: ["reviewed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by_membership_id: string | null
          access_profile: string
          created_at: string
          email: string
          expires_at: string
          grant_expires_at: string | null
          id: string
          invited_by_account_id: string | null
          job_category: string
          job_title: string | null
          organization_id: string
          portfolio_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          revoked_at: string | null
          revoked_by_account_id: string | null
          scope_type: string
          status: string
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by_membership_id?: string | null
          access_profile: string
          created_at?: string
          email: string
          expires_at: string
          grant_expires_at?: string | null
          id?: string
          invited_by_account_id?: string | null
          job_category?: string
          job_title?: string | null
          organization_id: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type: string
          status?: string
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by_membership_id?: string | null
          access_profile?: string
          created_at?: string
          email?: string
          expires_at?: string
          grant_expires_at?: string | null
          id?: string
          invited_by_account_id?: string | null
          job_category?: string
          job_title?: string | null
          organization_id?: string
          portfolio_id?: string | null
          property_id?: string | null
          property_relationship_id?: string | null
          revoked_at?: string | null
          revoked_by_account_id?: string | null
          scope_type?: string
          status?: string
          token_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_accept_membership_scope_fkey"
            columns: ["accepted_by_membership_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_invitations_invited_by_account_id_fkey"
            columns: ["invited_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "organization_invitations_property_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "organization_invitations_revoked_by_account_id_fkey"
            columns: ["revoked_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          account_id: string
          created_at: string
          created_by_account_id: string | null
          ended_at: string | null
          id: string
          job_category: string
          job_title: string | null
          organization_id: string
          starts_at: string
          status: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by_account_id?: string | null
          ended_at?: string | null
          id?: string
          job_category?: string
          job_title?: string | null
          organization_id: string
          starts_at?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by_account_id?: string | null
          ended_at?: string | null
          id?: string
          job_category?: string
          job_title?: string | null
          organization_id?: string
          starts_at?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_property_relationships: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          ends_at: string | null
          id: string
          is_primary_grouping: boolean
          organization_id: string
          property_id: string
          relationship_type: string
          starts_at: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          ends_at?: string | null
          id?: string
          is_primary_grouping?: boolean
          organization_id: string
          property_id: string
          relationship_type: string
          starts_at?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          ends_at?: string | null
          id?: string
          is_primary_grouping?: boolean
          organization_id?: string
          property_id?: string
          relationship_type?: string
          starts_at?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_property_relationships_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_property_relationships_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          id: string
          legacy_property_id: string | null
          name: string
          organization_type: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          legacy_property_id?: string | null
          name: string
          organization_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          legacy_property_id?: string | null
          name?: string
          organization_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_legacy_property_id_fkey"
            columns: ["legacy_property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          carrier: string | null
          created_at: string
          guest_name: string
          guest_notified_at: string | null
          guest_phone: string | null
          id: string
          logged_at: string
          logged_by_account_id: string | null
          notes: string | null
          photo_path: string | null
          picked_up_at: string | null
          picked_up_by_account_id: string | null
          property_id: string
          room_number: string | null
          status: string
          tracking_number: string | null
          updated_at: string
        }
        Insert: {
          carrier?: string | null
          created_at?: string
          guest_name: string
          guest_notified_at?: string | null
          guest_phone?: string | null
          id?: string
          logged_at?: string
          logged_by_account_id?: string | null
          notes?: string | null
          photo_path?: string | null
          picked_up_at?: string | null
          picked_up_by_account_id?: string | null
          property_id: string
          room_number?: string | null
          status?: string
          tracking_number?: string | null
          updated_at?: string
        }
        Update: {
          carrier?: string | null
          created_at?: string
          guest_name?: string
          guest_notified_at?: string | null
          guest_phone?: string | null
          id?: string
          logged_at?: string
          logged_by_account_id?: string | null
          notes?: string | null
          photo_path?: string | null
          picked_up_at?: string | null
          picked_up_by_account_id?: string | null
          property_id?: string
          room_number?: string | null
          status?: string
          tracking_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "packages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      password_signin_proofs: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          used_at: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          used_at?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          used_at?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      payment_history: {
        Row: {
          amount_cents: number
          created_at: string
          description: string | null
          id: string
          paid_on: string
          source: string
          vendor: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description?: string | null
          id?: string
          paid_on: string
          source?: string
          vendor: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string | null
          id?: string
          paid_on?: string
          source?: string
          vendor?: string
        }
        Relationships: []
      }
      phone_pairings: {
        Row: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string | null
          challenge_token_hash: string | null
          claimed_at: string | null
          completed_at: string | null
          completed_device_token_hash: string | null
          completed_session_id: string | null
          completion_expires_at: string | null
          completion_token_hash: string | null
          created_at: string
          desktop_ip: string | null
          desktop_user_agent: string | null
          id: string
          last_send_started_at: string | null
          otp_digest: string | null
          otp_expires_at: string | null
          otp_sent_at: string | null
          otp_verified_at: string | null
          pair_expires_at: string
          pairing_token_hash: string | null
          pending_otp_digest: string | null
          pending_supabase_hashed_token: string | null
          phone_ip: string | null
          phone_user_agent: string | null
          revoked_at: string | null
          send_count: number
          send_reservation_count: number | null
          send_reservation_id: string | null
          send_reservation_started_at: string | null
          supabase_hashed_token: string | null
          verify_attempt_count: number
        }
        Insert: {
          account_id: string
          auth_user_id: string
          challenge_expires_at?: string | null
          challenge_token_hash?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_device_token_hash?: string | null
          completed_session_id?: string | null
          completion_expires_at?: string | null
          completion_token_hash?: string | null
          created_at?: string
          desktop_ip?: string | null
          desktop_user_agent?: string | null
          id?: string
          last_send_started_at?: string | null
          otp_digest?: string | null
          otp_expires_at?: string | null
          otp_sent_at?: string | null
          otp_verified_at?: string | null
          pair_expires_at: string
          pairing_token_hash?: string | null
          pending_otp_digest?: string | null
          pending_supabase_hashed_token?: string | null
          phone_ip?: string | null
          phone_user_agent?: string | null
          revoked_at?: string | null
          send_count?: number
          send_reservation_count?: number | null
          send_reservation_id?: string | null
          send_reservation_started_at?: string | null
          supabase_hashed_token?: string | null
          verify_attempt_count?: number
        }
        Update: {
          account_id?: string
          auth_user_id?: string
          challenge_expires_at?: string | null
          challenge_token_hash?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_device_token_hash?: string | null
          completed_session_id?: string | null
          completion_expires_at?: string | null
          completion_token_hash?: string | null
          created_at?: string
          desktop_ip?: string | null
          desktop_user_agent?: string | null
          id?: string
          last_send_started_at?: string | null
          otp_digest?: string | null
          otp_expires_at?: string | null
          otp_sent_at?: string | null
          otp_verified_at?: string | null
          pair_expires_at?: string
          pairing_token_hash?: string | null
          pending_otp_digest?: string | null
          pending_supabase_hashed_token?: string | null
          phone_ip?: string | null
          phone_user_agent?: string | null
          revoked_at?: string | null
          send_count?: number
          send_reservation_count?: number | null
          send_reservation_id?: string | null
          send_reservation_started_at?: string | null
          supabase_hashed_token?: string | null
          verify_attempt_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "phone_pairings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_snapshots: {
        Row: {
          arrival_room_numbers: string[] | null
          arrivals: number | null
          checkout_minutes: number | null
          checkout_room_numbers: string[] | null
          checkouts: number | null
          date: string
          ooo: number | null
          ooo_room_numbers: string[] | null
          property_id: string
          pull_type: string | null
          pulled_at: string | null
          recommended_hks: number | null
          rooms: Json | null
          stayover_arrival_day: number | null
          stayover_arrival_room_numbers: string[] | null
          stayover_day1: number | null
          stayover_day1_minutes: number | null
          stayover_day1_room_numbers: string[] | null
          stayover_day2: number | null
          stayover_day2_minutes: number | null
          stayover_day2_room_numbers: string[] | null
          stayover_unknown: number | null
          stayovers: number | null
          total_cleaning_minutes: number | null
          total_rooms: number | null
          vacant_clean: number | null
          vacant_clean_room_numbers: string[] | null
          vacant_dirty: number | null
          vacant_dirty_minutes: number | null
          vacant_dirty_room_numbers: string[] | null
        }
        Insert: {
          arrival_room_numbers?: string[] | null
          arrivals?: number | null
          checkout_minutes?: number | null
          checkout_room_numbers?: string[] | null
          checkouts?: number | null
          date: string
          ooo?: number | null
          ooo_room_numbers?: string[] | null
          property_id: string
          pull_type?: string | null
          pulled_at?: string | null
          recommended_hks?: number | null
          rooms?: Json | null
          stayover_arrival_day?: number | null
          stayover_arrival_room_numbers?: string[] | null
          stayover_day1?: number | null
          stayover_day1_minutes?: number | null
          stayover_day1_room_numbers?: string[] | null
          stayover_day2?: number | null
          stayover_day2_minutes?: number | null
          stayover_day2_room_numbers?: string[] | null
          stayover_unknown?: number | null
          stayovers?: number | null
          total_cleaning_minutes?: number | null
          total_rooms?: number | null
          vacant_clean?: number | null
          vacant_clean_room_numbers?: string[] | null
          vacant_dirty?: number | null
          vacant_dirty_minutes?: number | null
          vacant_dirty_room_numbers?: string[] | null
        }
        Update: {
          arrival_room_numbers?: string[] | null
          arrivals?: number | null
          checkout_minutes?: number | null
          checkout_room_numbers?: string[] | null
          checkouts?: number | null
          date?: string
          ooo?: number | null
          ooo_room_numbers?: string[] | null
          property_id?: string
          pull_type?: string | null
          pulled_at?: string | null
          recommended_hks?: number | null
          rooms?: Json | null
          stayover_arrival_day?: number | null
          stayover_arrival_room_numbers?: string[] | null
          stayover_day1?: number | null
          stayover_day1_minutes?: number | null
          stayover_day1_room_numbers?: string[] | null
          stayover_day2?: number | null
          stayover_day2_minutes?: number | null
          stayover_day2_room_numbers?: string[] | null
          stayover_unknown?: number | null
          stayovers?: number | null
          total_cleaning_minutes?: number | null
          total_rooms?: number | null
          vacant_clean?: number | null
          vacant_clean_room_numbers?: string[] | null
          vacant_dirty?: number | null
          vacant_dirty_minutes?: number | null
          vacant_dirty_room_numbers?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_activity_log: {
        Row: {
          action: string | null
          captured_at: string
          details: Json | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          pms_user: string | null
          property_id: string
          raw: Json | null
          target: string | null
        }
        Insert: {
          action?: string | null
          captured_at?: string
          details?: Json | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          pms_user?: string | null
          property_id: string
          raw?: Json | null
          target?: string | null
        }
        Update: {
          action?: string | null
          captured_at?: string
          details?: Json | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          pms_user?: string | null
          property_id?: string
          raw?: Json | null
          target?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_activity_log_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_activity_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_auth_codes: {
        Row: {
          code: string
          consumed_at: string | null
          email_to: string
          id: string
          property_id: string
          raw_ref: string | null
          received_at: string
          sender: string | null
          source: string
          subject: string | null
        }
        Insert: {
          code: string
          consumed_at?: string | null
          email_to: string
          id?: string
          property_id: string
          raw_ref?: string | null
          received_at?: string
          sender?: string | null
          source?: string
          subject?: string | null
        }
        Update: {
          code?: string
          consumed_at?: string | null
          email_to?: string
          id?: string
          property_id?: string
          raw_ref?: string | null
          received_at?: string
          sender?: string | null
          source?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_auth_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_booking_pace: {
        Row: {
          adr_otb_cents: number | null
          as_of_date: string
          cancellations_to_date: number | null
          created_at: string
          group_rooms_otb: number | null
          id: string
          ingest_run_id: string
          observed_at: string | null
          property_id: string
          raw: Json | null
          revenue_otb_cents: number | null
          rooms_available: number | null
          rooms_otb: number | null
          stay_date: string
          transient_rooms_otb: number | null
        }
        Insert: {
          adr_otb_cents?: number | null
          as_of_date: string
          cancellations_to_date?: number | null
          created_at?: string
          group_rooms_otb?: number | null
          id?: string
          ingest_run_id: string
          observed_at?: string | null
          property_id: string
          raw?: Json | null
          revenue_otb_cents?: number | null
          rooms_available?: number | null
          rooms_otb?: number | null
          stay_date: string
          transient_rooms_otb?: number | null
        }
        Update: {
          adr_otb_cents?: number | null
          as_of_date?: string
          cancellations_to_date?: number | null
          created_at?: string
          group_rooms_otb?: number | null
          id?: string
          ingest_run_id?: string
          observed_at?: string | null
          property_id?: string
          raw?: Json | null
          revenue_otb_cents?: number | null
          rooms_available?: number | null
          rooms_otb?: number | null
          stay_date?: string
          transient_rooms_otb?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_booking_pace_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_booking_pace_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_cancellations: {
        Row: {
          arrival_date: string | null
          cancellation_fee_cents: number | null
          cancelled_date: string
          captured_at: string
          channel_name: string | null
          created_at: string
          departure_date: string | null
          guest_name: string | null
          id: string
          ingest_run_id: string
          pms_reservation_id: string
          property_id: string
          raw: Json | null
          reason: string | null
          room_number: string | null
          total_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          arrival_date?: string | null
          cancellation_fee_cents?: number | null
          cancelled_date: string
          captured_at?: string
          channel_name?: string | null
          created_at?: string
          departure_date?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id: string
          pms_reservation_id: string
          property_id: string
          raw?: Json | null
          reason?: string | null
          room_number?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          arrival_date?: string | null
          cancellation_fee_cents?: number | null
          cancelled_date?: string
          captured_at?: string
          channel_name?: string | null
          created_at?: string
          departure_date?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id?: string
          pms_reservation_id?: string
          property_id?: string
          raw?: Json | null
          reason?: string | null
          room_number?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_cancellations_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_cancellations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_channel_performance: {
        Row: {
          as_of: string
          average_lead_time_days: number | null
          average_length_of_stay: number | null
          bookings_count: number | null
          business_date: string
          business_date_source: string
          cancellation_rate_pct: number | null
          channel: string
          commission_paid_cents: number | null
          commission_rate_pct: number | null
          created_at: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          property_id: string
          raw: Json | null
          revenue_cents: number | null
          rooms_sold: number | null
        }
        Insert: {
          as_of: string
          average_lead_time_days?: number | null
          average_length_of_stay?: number | null
          bookings_count?: number | null
          business_date: string
          business_date_source: string
          cancellation_rate_pct?: number | null
          channel: string
          commission_paid_cents?: number | null
          commission_rate_pct?: number | null
          created_at?: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          property_id: string
          raw?: Json | null
          revenue_cents?: number | null
          rooms_sold?: number | null
        }
        Update: {
          as_of?: string
          average_lead_time_days?: number | null
          average_length_of_stay?: number | null
          bookings_count?: number | null
          business_date?: string
          business_date_source?: string
          cancellation_rate_pct?: number | null
          channel?: string
          commission_paid_cents?: number | null
          commission_rate_pct?: number | null
          created_at?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          property_id?: string
          raw?: Json | null
          revenue_cents?: number | null
          rooms_sold?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_channel_performance_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_channel_performance_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_entity_change_log: {
        Row: {
          after: Json
          before: Json
          changed_at: string
          changed_fields: string[]
          entity_key: string
          id: string
          ingest_run_id: string | null
          property_id: string
          table_name: string
        }
        Insert: {
          after: Json
          before: Json
          changed_at?: string
          changed_fields: string[]
          entity_key: string
          id?: string
          ingest_run_id?: string | null
          property_id: string
          table_name: string
        }
        Update: {
          after?: Json
          before?: Json
          changed_at?: string
          changed_fields?: string[]
          entity_key?: string
          id?: string
          ingest_run_id?: string | null
          property_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_entity_change_log_ingest_run_id_fkey"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_entity_change_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_catalog: {
        Row: {
          created_at: string
          feed_key: string
          label: string
          legacy_target: string | null
          notes: string | null
          required: boolean
          target_table: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          feed_key: string
          label: string
          legacy_target?: string | null
          notes?: string | null
          required?: boolean
          target_table?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          feed_key?: string
          label?: string
          legacy_target?: string | null
          notes?: string | null
          required?: boolean
          target_table?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_catalog_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_feed_expectations: {
        Row: {
          alert_channel: string
          cadence_kind: string
          created_at: string
          enabled: boolean
          expected_at_local: string | null
          expected_every_minutes: number | null
          feed_key: string
          grace_minutes: number
          notes: string | null
          property_id: string
          report_type: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          alert_channel?: string
          cadence_kind: string
          created_at?: string
          enabled?: boolean
          expected_at_local?: string | null
          expected_every_minutes?: number | null
          feed_key: string
          grace_minutes?: number
          notes?: string | null
          property_id: string
          report_type?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          alert_channel?: string
          cadence_kind?: string
          created_at?: string
          enabled?: boolean
          expected_at_local?: string | null
          expected_every_minutes?: number | null
          feed_key?: string
          grace_minutes?: number
          notes?: string | null
          property_id?: string
          report_type?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_expectations_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_values: {
        Row: {
          captured_at: string
          feed_key: string
          has_error: boolean
          ingest_run_id: string
          last_error: string | null
          last_error_at: string | null
          last_good_at: string | null
          last_synced_at: string
          property_id: string
          values: Json
        }
        Insert: {
          captured_at?: string
          feed_key: string
          has_error?: boolean
          ingest_run_id: string
          last_error?: string | null
          last_error_at?: string | null
          last_good_at?: string | null
          last_synced_at?: string
          property_id: string
          values?: Json
        }
        Update: {
          captured_at?: string
          feed_key?: string
          has_error?: boolean
          ingest_run_id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_good_at?: string | null
          last_synced_at?: string
          property_id?: string
          values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_values_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_feed_values_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_forecast_daily: {
        Row: {
          booking_pace_indicator: string | null
          created_at: string
          forecast_date: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          projected_adr_cents: number | null
          projected_arrivals: number | null
          projected_departures: number | null
          projected_in_house: number | null
          projected_occupancy_pct: number | null
          projected_revenue_cents: number | null
          projected_revpar_cents: number | null
          property_id: string
          raw: Json | null
          snapshot_date: string
          vs_same_day_last_year_pct: number | null
        }
        Insert: {
          booking_pace_indicator?: string | null
          created_at?: string
          forecast_date: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          projected_adr_cents?: number | null
          projected_arrivals?: number | null
          projected_departures?: number | null
          projected_in_house?: number | null
          projected_occupancy_pct?: number | null
          projected_revenue_cents?: number | null
          projected_revpar_cents?: number | null
          property_id: string
          raw?: Json | null
          snapshot_date: string
          vs_same_day_last_year_pct?: number | null
        }
        Update: {
          booking_pace_indicator?: string | null
          created_at?: string
          forecast_date?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          projected_adr_cents?: number | null
          projected_arrivals?: number | null
          projected_departures?: number | null
          projected_in_house?: number | null
          projected_occupancy_pct?: number | null
          projected_revenue_cents?: number | null
          projected_revpar_cents?: number | null
          property_id?: string
          raw?: Json | null
          snapshot_date?: string
          vs_same_day_last_year_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_forecast_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_forecast_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_groups_and_blocks: {
        Row: {
          block_end_date: string | null
          block_start_date: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          cutoff_date: string | null
          group_name: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          package_details: Json | null
          pickup_pct: number | null
          pms_group_id: string
          property_id: string
          rate_cents: number | null
          raw: Json | null
          rooms_blocked: number | null
          rooms_picked_up: number | null
          status: string | null
          updated_at: string
        }
        Insert: {
          block_end_date?: string | null
          block_start_date?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          cutoff_date?: string | null
          group_name?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          package_details?: Json | null
          pickup_pct?: number | null
          pms_group_id: string
          property_id: string
          rate_cents?: number | null
          raw?: Json | null
          rooms_blocked?: number | null
          rooms_picked_up?: number | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          block_end_date?: string | null
          block_start_date?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          cutoff_date?: string | null
          group_name?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          package_details?: Json | null
          pickup_pct?: number | null
          pms_group_id?: string
          property_id?: string
          rate_cents?: number | null
          raw?: Json | null
          rooms_blocked?: number | null
          rooms_picked_up?: number | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_groups_and_blocks_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_groups_and_blocks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_guest_balances: {
        Row: {
          balance_cents: number | null
          captured_at: string
          created_at: string
          deposit_cents: number | null
          folio_status: string | null
          guest_name: string | null
          id: string
          ingest_run_id: string
          last_payment_cents: number | null
          last_payment_method: string | null
          pms_folio_id: string
          pms_reservation_id: string | null
          property_id: string
          raw: Json | null
          room_number: string | null
          updated_at: string
        }
        Insert: {
          balance_cents?: number | null
          captured_at?: string
          created_at?: string
          deposit_cents?: number | null
          folio_status?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id: string
          last_payment_cents?: number | null
          last_payment_method?: string | null
          pms_folio_id: string
          pms_reservation_id?: string | null
          property_id: string
          raw?: Json | null
          room_number?: string | null
          updated_at?: string
        }
        Update: {
          balance_cents?: number | null
          captured_at?: string
          created_at?: string
          deposit_cents?: number | null
          folio_status?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id?: string
          last_payment_cents?: number | null
          last_payment_method?: string | null
          pms_folio_id?: string
          pms_reservation_id?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_guest_balances_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_guest_balances_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_guests: {
        Row: {
          address: string | null
          anniversary: string | null
          average_stay_length: number | null
          birthday: string | null
          city: string | null
          corporate_affiliation: string | null
          country: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          group_affiliation: string | null
          id: string
          id_number_last4: string | null
          id_type: string | null
          ingest_run_id: string
          last_room_number: string | null
          last_stay_date: string | null
          last_synced_at: string
          lifetime_stays: number | null
          lifetime_value_cents: number | null
          loyalty_member_since: string | null
          loyalty_points: number | null
          loyalty_program: string | null
          loyalty_tier: string | null
          name: string | null
          nationality: string | null
          notes: string | null
          phone: string | null
          pms_guest_id: string
          postal_code: string | null
          preferences: Json | null
          property_id: string
          raw: Json | null
          special_status: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          anniversary?: string | null
          average_stay_length?: number | null
          birthday?: string | null
          city?: string | null
          corporate_affiliation?: string | null
          country?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          group_affiliation?: string | null
          id?: string
          id_number_last4?: string | null
          id_type?: string | null
          ingest_run_id: string
          last_room_number?: string | null
          last_stay_date?: string | null
          last_synced_at?: string
          lifetime_stays?: number | null
          lifetime_value_cents?: number | null
          loyalty_member_since?: string | null
          loyalty_points?: number | null
          loyalty_program?: string | null
          loyalty_tier?: string | null
          name?: string | null
          nationality?: string | null
          notes?: string | null
          phone?: string | null
          pms_guest_id: string
          postal_code?: string | null
          preferences?: Json | null
          property_id: string
          raw?: Json | null
          special_status?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          anniversary?: string | null
          average_stay_length?: number | null
          birthday?: string | null
          city?: string | null
          corporate_affiliation?: string | null
          country?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          group_affiliation?: string | null
          id?: string
          id_number_last4?: string | null
          id_type?: string | null
          ingest_run_id?: string
          last_room_number?: string | null
          last_stay_date?: string | null
          last_synced_at?: string
          lifetime_stays?: number | null
          lifetime_value_cents?: number | null
          loyalty_member_since?: string | null
          loyalty_points?: number | null
          loyalty_program?: string | null
          loyalty_tier?: string | null
          name?: string | null
          nationality?: string | null
          notes?: string | null
          phone?: string | null
          pms_guest_id?: string
          postal_code?: string | null
          preferences?: Json | null
          property_id?: string
          raw?: Json | null
          special_status?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_guests_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_guests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_housekeeping_assignments: {
        Row: {
          checklist_progress: string[]
          checklist_template_id: string | null
          cleaning_type: string | null
          completed_at: string | null
          created_at: string
          date: string
          dnd_active: boolean | null
          dnd_note: string | null
          dnd_until: string | null
          early_checkin_approved: boolean | null
          early_checkin_from: string | null
          exception_at: string | null
          exception_note: string | null
          exception_type: string | null
          help_requested: boolean
          housekeeper_name: string | null
          housekeeper_note: string | null
          housekeeper_note_at: string | null
          id: string
          ingest_run_id: string
          inspected_at: string | null
          inspected_by: string | null
          is_paused: boolean
          is_rush: boolean
          issue_note: string | null
          last_synced_at: string
          late_checkout_approved: boolean | null
          late_checkout_until: string | null
          manager_notes: string | null
          manager_notes_at: string | null
          manager_notes_by_account_id: string | null
          marked_for_inspection_at: string | null
          notes: string | null
          paused_at: string | null
          property_id: string
          raw: Json | null
          refused_reason: string | null
          room_number: string
          rush_due_by: string | null
          rush_duration_label: string | null
          rush_requested_by_account_id: string | null
          rush_set_at: string | null
          rush_set_by: string | null
          scheduled_time: string | null
          service_requested: string | null
          started_at: string | null
          status: string | null
          time_spent_minutes: number | null
          total_paused_seconds: number
          updated_at: string
        }
        Insert: {
          checklist_progress?: string[]
          checklist_template_id?: string | null
          cleaning_type?: string | null
          completed_at?: string | null
          created_at?: string
          date: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          dnd_until?: string | null
          early_checkin_approved?: boolean | null
          early_checkin_from?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_name?: string | null
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          id?: string
          ingest_run_id: string
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          last_synced_at?: string
          late_checkout_approved?: boolean | null
          late_checkout_until?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          notes?: string | null
          paused_at?: string | null
          property_id: string
          raw?: Json | null
          refused_reason?: string | null
          room_number: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          scheduled_time?: string | null
          service_requested?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Update: {
          checklist_progress?: string[]
          checklist_template_id?: string | null
          cleaning_type?: string | null
          completed_at?: string | null
          created_at?: string
          date?: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          dnd_until?: string | null
          early_checkin_approved?: boolean | null
          early_checkin_from?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_name?: string | null
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          id?: string
          ingest_run_id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          last_synced_at?: string
          late_checkout_approved?: boolean | null
          late_checkout_until?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          notes?: string | null
          paused_at?: string | null
          property_id?: string
          raw?: Json | null
          refused_reason?: string | null
          room_number?: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          scheduled_time?: string | null
          service_requested?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_housekeeping_assignments_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_housekeeping_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_inbox_messages: {
        Row: {
          body_html: string | null
          body_text: string | null
          created_at: string
          email_to: string
          from_addr: string | null
          id: string
          inbox_domain: string | null
          kind: string
          message_id: string | null
          property_id: string
          received_at: string
          report_file_id: string | null
          subject: string | null
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          email_to: string
          from_addr?: string | null
          id?: string
          inbox_domain?: string | null
          kind?: string
          message_id?: string | null
          property_id: string
          received_at?: string
          report_file_id?: string | null
          subject?: string | null
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          email_to?: string
          from_addr?: string | null
          id?: string
          inbox_domain?: string | null
          kind?: string
          message_id?: string | null
          property_id?: string
          received_at?: string
          report_file_id?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_inbox_messages_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_inbox_messages_report_file_fk"
            columns: ["report_file_id"]
            isOneToOne: false
            referencedRelation: "pms_report_files"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_ingest_anomalies: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          baseline: number | null
          detail: string | null
          detected_at: string
          feed_key: string | null
          id: string
          kind: string
          observed: number | null
          property_id: string
          ratio: number | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          baseline?: number | null
          detail?: string | null
          detected_at?: string
          feed_key?: string | null
          id?: string
          kind: string
          observed?: number | null
          property_id: string
          ratio?: number | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          baseline?: number | null
          detail?: string | null
          detected_at?: string
          feed_key?: string | null
          id?: string
          kind?: string
          observed?: number | null
          property_id?: string
          ratio?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_anomalies_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_ingest_anomalies_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_ingest_quarantine: {
        Row: {
          delivery_id: string | null
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrences: number
          property_id: string
          raw_row: Json
          reason_code: string
          reason_detail: string | null
          report_type: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          row_index: number | null
          status: string
          target_table: string | null
        }
        Insert: {
          delivery_id?: string | null
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          property_id: string
          raw_row: Json
          reason_code: string
          reason_detail?: string | null
          report_type?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          status?: string
          target_table?: string | null
        }
        Update: {
          delivery_id?: string | null
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          property_id?: string
          raw_row?: Json
          reason_code?: string
          reason_detail?: string | null
          report_type?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          row_index?: number | null
          status?: string
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_quarantine_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_quarantine_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_ingest_runs: {
        Row: {
          attempt_count: number
          diff: Json | null
          error: string | null
          finished_at: string | null
          id: string
          knowledge_file_id: string | null
          mode: string
          parser_name: string
          parser_version: string
          property_id: string
          report_file_id: string | null
          rows_rejected: number
          rows_written: number
          source_captured_at: string
          source_kind: string
          started_at: string
          status: string
        }
        Insert: {
          attempt_count?: number
          diff?: Json | null
          error?: string | null
          finished_at?: string | null
          id?: string
          knowledge_file_id?: string | null
          mode?: string
          parser_name: string
          parser_version: string
          property_id: string
          report_file_id?: string | null
          rows_rejected?: number
          rows_written?: number
          source_captured_at: string
          source_kind: string
          started_at?: string
          status?: string
        }
        Update: {
          attempt_count?: number
          diff?: Json | null
          error?: string | null
          finished_at?: string | null
          id?: string
          knowledge_file_id?: string | null
          mode?: string
          parser_name?: string
          parser_version?: string
          property_id?: string
          report_file_id?: string | null
          rows_rejected?: number
          rows_written?: number
          source_captured_at?: string
          source_kind?: string
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_runs_knowledge_file_id_fkey"
            columns: ["knowledge_file_id"]
            isOneToOne: false
            referencedRelation: "pms_knowledge_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_runs_report_file_id_fkey"
            columns: ["report_file_id"]
            isOneToOne: false
            referencedRelation: "pms_report_files"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_knowledge_files: {
        Row: {
          created_at: string
          created_by: string
          deleted_at: string | null
          deprecated_at: string | null
          disabled_feeds: Json
          display_name: string | null
          id: string
          knowledge: Json
          learned_at: string
          notes: string | null
          pms_family: string
          promoted_to_active_at: string | null
          signature: string | null
          signed_at: string | null
          signed_with_key_id: string | null
          status: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deprecated_at?: string | null
          disabled_feeds?: Json
          display_name?: string | null
          id?: string
          knowledge: Json
          learned_at?: string
          notes?: string | null
          pms_family: string
          promoted_to_active_at?: string | null
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deprecated_at?: string | null
          disabled_feeds?: Json
          display_name?: string | null
          id?: string
          knowledge?: Json
          learned_at?: string
          notes?: string | null
          pms_family?: string
          promoted_to_active_at?: string | null
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          version?: number
        }
        Relationships: []
      }
      pms_lost_and_found: {
        Row: {
          claimed_at: string | null
          claimed_by_guest: string | null
          created_at: string
          found_at: string | null
          found_by: string | null
          id: string
          ingest_run_id: string
          item_description: string | null
          last_synced_at: string
          location_found: string | null
          notes: string | null
          pms_item_id: string | null
          property_id: string
          raw: Json | null
          room_number: string | null
          shipping_info: Json | null
          status: string | null
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by_guest?: string | null
          created_at?: string
          found_at?: string | null
          found_by?: string | null
          id?: string
          ingest_run_id: string
          item_description?: string | null
          last_synced_at?: string
          location_found?: string | null
          notes?: string | null
          pms_item_id?: string | null
          property_id: string
          raw?: Json | null
          room_number?: string | null
          shipping_info?: Json | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by_guest?: string | null
          created_at?: string
          found_at?: string | null
          found_by?: string | null
          id?: string
          ingest_run_id?: string
          item_description?: string | null
          last_synced_at?: string
          location_found?: string | null
          notes?: string | null
          pms_item_id?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string | null
          shipping_info?: Json | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_lost_and_found_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_lost_and_found_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_no_shows: {
        Row: {
          arrival_date: string
          captured_at: string
          channel_name: string | null
          created_at: string
          departure_date: string | null
          guest_name: string | null
          id: string
          ingest_run_id: string
          no_show_date: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents: number | null
          raw: Json | null
          room_number: string | null
          total_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          arrival_date: string
          captured_at?: string
          channel_name?: string | null
          created_at?: string
          departure_date?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id: string
          no_show_date?: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          arrival_date?: string
          captured_at?: string
          channel_name?: string | null
          created_at?: string
          departure_date?: string | null
          guest_name?: string | null
          id?: string
          ingest_run_id?: string
          no_show_date?: string | null
          pms_reservation_id?: string
          property_id?: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_no_shows_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_no_shows_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_occupancy_observation: {
        Row: {
          arrivals_remaining_today: number | null
          business_date: string
          cancellations_today: number | null
          captured_at: string
          checked_in_today_count: number | null
          checked_out_today_count: number | null
          departures_remaining_today: number | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          no_shows_today: number | null
          observed_at: string
          observed_at_source: string
          property_id: string
          raw: Json | null
          revenue_today_so_far_cents: number | null
          special_needs_guests_in_house: number | null
          total_guests_in_house: number | null
          total_occupied_rooms: number | null
          total_ooo: number | null
          total_vacant_clean: number | null
          total_vacant_dirty: number | null
          vip_guests_in_house: number | null
          walk_ins_today: number | null
        }
        Insert: {
          arrivals_remaining_today?: number | null
          business_date: string
          cancellations_today?: number | null
          captured_at?: string
          checked_in_today_count?: number | null
          checked_out_today_count?: number | null
          departures_remaining_today?: number | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          no_shows_today?: number | null
          observed_at: string
          observed_at_source: string
          property_id: string
          raw?: Json | null
          revenue_today_so_far_cents?: number | null
          special_needs_guests_in_house?: number | null
          total_guests_in_house?: number | null
          total_occupied_rooms?: number | null
          total_ooo?: number | null
          total_vacant_clean?: number | null
          total_vacant_dirty?: number | null
          vip_guests_in_house?: number | null
          walk_ins_today?: number | null
        }
        Update: {
          arrivals_remaining_today?: number | null
          business_date?: string
          cancellations_today?: number | null
          captured_at?: string
          checked_in_today_count?: number | null
          checked_out_today_count?: number | null
          departures_remaining_today?: number | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          no_shows_today?: number | null
          observed_at?: string
          observed_at_source?: string
          property_id?: string
          raw?: Json | null
          revenue_today_so_far_cents?: number | null
          special_needs_guests_in_house?: number | null
          total_guests_in_house?: number | null
          total_occupied_rooms?: number | null
          total_ooo?: number | null
          total_vacant_clean?: number | null
          total_vacant_dirty?: number | null
          vip_guests_in_house?: number | null
          walk_ins_today?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_in_house_snapshot_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_in_house_snapshot_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_payments_daily: {
        Row: {
          as_of: string
          business_date: string
          business_date_source: string
          captured_at: string
          card_collected_cents: number | null
          cash_collected_cents: number | null
          created_at: string
          deposits_collected_cents: number | null
          id: string
          ingest_run_id: string
          property_id: string
          raw: Json | null
          total_collected_cents: number | null
          updated_at: string
        }
        Insert: {
          as_of: string
          business_date: string
          business_date_source: string
          captured_at?: string
          card_collected_cents?: number | null
          cash_collected_cents?: number | null
          created_at?: string
          deposits_collected_cents?: number | null
          id?: string
          ingest_run_id: string
          property_id: string
          raw?: Json | null
          total_collected_cents?: number | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          business_date?: string
          business_date_source?: string
          captured_at?: string
          card_collected_cents?: number | null
          cash_collected_cents?: number | null
          created_at?: string
          deposits_collected_cents?: number | null
          id?: string
          ingest_run_id?: string
          property_id?: string
          raw?: Json | null
          total_collected_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_payments_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_payments_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_rates_and_inventory: {
        Row: {
          as_of: string
          available_rooms: number | null
          captured_at: string
          id: string
          ingest_run_id: string
          last_synced_at: string
          property_id: string
          rate_amount_cents: number | null
          rate_loaded_in_channel_manager: boolean | null
          rate_parity_status: Json | null
          rate_plan: string | null
          raw: Json | null
          room_type: string
          stay_date: string
        }
        Insert: {
          as_of: string
          available_rooms?: number | null
          captured_at?: string
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          property_id: string
          rate_amount_cents?: number | null
          rate_loaded_in_channel_manager?: boolean | null
          rate_parity_status?: Json | null
          rate_plan?: string | null
          raw?: Json | null
          room_type: string
          stay_date: string
        }
        Update: {
          as_of?: string
          available_rooms?: number | null
          captured_at?: string
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          property_id?: string
          rate_amount_cents?: number | null
          rate_loaded_in_channel_manager?: boolean | null
          rate_parity_status?: Json | null
          rate_plan?: string | null
          raw?: Json | null
          room_type?: string
          stay_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_rates_and_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rates_and_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_report_files: {
        Row: {
          business_date: string | null
          byte_size: number
          contains_pan: boolean
          content_sha256: string
          from_addr: string | null
          id: string
          last_error: string | null
          message_id: string
          mime_type: string | null
          original_filename: string | null
          property_id: string
          raw_purged_at: string | null
          received_at: string
          report_kind: string | null
          sender_approved: boolean
          sender_domain: string | null
          source_captured_at: string
          status: string
          storage_path: string | null
          subject: string | null
        }
        Insert: {
          business_date?: string | null
          byte_size: number
          contains_pan?: boolean
          content_sha256: string
          from_addr?: string | null
          id?: string
          last_error?: string | null
          message_id: string
          mime_type?: string | null
          original_filename?: string | null
          property_id: string
          raw_purged_at?: string | null
          received_at?: string
          report_kind?: string | null
          sender_approved?: boolean
          sender_domain?: string | null
          source_captured_at: string
          status?: string
          storage_path?: string | null
          subject?: string | null
        }
        Update: {
          business_date?: string | null
          byte_size?: number
          contains_pan?: boolean
          content_sha256?: string
          from_addr?: string | null
          id?: string
          last_error?: string | null
          message_id?: string
          mime_type?: string | null
          original_filename?: string | null
          property_id?: string
          raw_purged_at?: string | null
          received_at?: string
          report_kind?: string | null
          sender_approved?: boolean
          sender_domain?: string | null
          source_captured_at?: string
          status?: string
          storage_path?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_reports_cache_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_reservations: {
        Row: {
          accessibility_needs: string | null
          adults: number | null
          arrival_date: string | null
          arrival_time: string | null
          cancellation_policy: string | null
          channel_name: string | null
          children: number | null
          corporate_account: string | null
          created_at: string
          currency: string | null
          departure_date: string | null
          departure_time: string | null
          deposit_amount_cents: number | null
          deposit_status: string | null
          dietary_needs: string | null
          group_block_id: string | null
          guest_name: string | null
          id: string
          infants: number | null
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          num_nights: number | null
          package_name: string | null
          payment_method: string | null
          pms_guest_id: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents: number | null
          raw: Json | null
          room_number: string | null
          room_type: string | null
          source: string | null
          special_requests: string | null
          status: string | null
          status_changed_at: string | null
          total_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          accessibility_needs?: string | null
          adults?: number | null
          arrival_date?: string | null
          arrival_time?: string | null
          cancellation_policy?: string | null
          channel_name?: string | null
          children?: number | null
          corporate_account?: string | null
          created_at?: string
          currency?: string | null
          departure_date?: string | null
          departure_time?: string | null
          deposit_amount_cents?: number | null
          deposit_status?: string | null
          dietary_needs?: string | null
          group_block_id?: string | null
          guest_name?: string | null
          id?: string
          infants?: number | null
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          num_nights?: number | null
          package_name?: string | null
          payment_method?: string | null
          pms_guest_id?: string | null
          pms_reservation_id: string
          property_id: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          room_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          status_changed_at?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          accessibility_needs?: string | null
          adults?: number | null
          arrival_date?: string | null
          arrival_time?: string | null
          cancellation_policy?: string | null
          channel_name?: string | null
          children?: number | null
          corporate_account?: string | null
          created_at?: string
          currency?: string | null
          departure_date?: string | null
          departure_time?: string | null
          deposit_amount_cents?: number | null
          deposit_status?: string | null
          dietary_needs?: string | null
          group_block_id?: string | null
          guest_name?: string | null
          id?: string
          infants?: number | null
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          num_nights?: number | null
          package_name?: string | null
          payment_method?: string | null
          pms_guest_id?: string | null
          pms_reservation_id?: string
          property_id?: string
          rate_per_night_cents?: number | null
          raw?: Json | null
          room_number?: string | null
          room_type?: string | null
          source?: string | null
          special_requests?: string | null
          status?: string | null
          status_changed_at?: string | null
          total_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_reservations_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_reservations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_revenue_daily: {
        Row: {
          adjustments_cents: number | null
          adr_cents: number | null
          ancillary_revenue_cents: number | null
          as_of: string
          available_rooms: number | null
          business_date: string
          business_date_source: string
          channel_commission_breakdown: Json | null
          comps_cents: number | null
          created_at: string
          discounts_cents: number | null
          fnb_revenue_cents: number | null
          goppar_cents: number | null
          gross_operating_profit_cents: number | null
          group_revenue_cents: number | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          occupancy_pct: number | null
          occupied_rooms: number | null
          ooo_rooms: number | null
          ota_commission_paid_cents: number | null
          property_id: string
          raw: Json | null
          refunds_cents: number | null
          revpar_cents: number | null
          rooms_revenue_cents: number | null
          taxes_collected: Json | null
          total_revenue_cents: number | null
          transient_revenue_cents: number | null
          updated_at: string
          walk_in_revenue_cents: number | null
        }
        Insert: {
          adjustments_cents?: number | null
          adr_cents?: number | null
          ancillary_revenue_cents?: number | null
          as_of: string
          available_rooms?: number | null
          business_date: string
          business_date_source: string
          channel_commission_breakdown?: Json | null
          comps_cents?: number | null
          created_at?: string
          discounts_cents?: number | null
          fnb_revenue_cents?: number | null
          goppar_cents?: number | null
          gross_operating_profit_cents?: number | null
          group_revenue_cents?: number | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          occupancy_pct?: number | null
          occupied_rooms?: number | null
          ooo_rooms?: number | null
          ota_commission_paid_cents?: number | null
          property_id: string
          raw?: Json | null
          refunds_cents?: number | null
          revpar_cents?: number | null
          rooms_revenue_cents?: number | null
          taxes_collected?: Json | null
          total_revenue_cents?: number | null
          transient_revenue_cents?: number | null
          updated_at?: string
          walk_in_revenue_cents?: number | null
        }
        Update: {
          adjustments_cents?: number | null
          adr_cents?: number | null
          ancillary_revenue_cents?: number | null
          as_of?: string
          available_rooms?: number | null
          business_date?: string
          business_date_source?: string
          channel_commission_breakdown?: Json | null
          comps_cents?: number | null
          created_at?: string
          discounts_cents?: number | null
          fnb_revenue_cents?: number | null
          goppar_cents?: number | null
          gross_operating_profit_cents?: number | null
          group_revenue_cents?: number | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          occupancy_pct?: number | null
          occupied_rooms?: number | null
          ooo_rooms?: number | null
          ota_commission_paid_cents?: number | null
          property_id?: string
          raw?: Json | null
          refunds_cents?: number | null
          revpar_cents?: number | null
          rooms_revenue_cents?: number | null
          taxes_collected?: Json | null
          total_revenue_cents?: number | null
          transient_revenue_cents?: number | null
          updated_at?: string
          walk_in_revenue_cents?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_revenue_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_revenue_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_room_status_log: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          property_id: string
          raw: Json | null
          room_number: string
          source: string
          status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          property_id: string
          raw?: Json | null
          room_number: string
          source?: string
          status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          property_id?: string
          raw?: Json | null
          room_number?: string
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_room_status_log_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_room_status_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_rooms_inventory: {
        Row: {
          accessible: boolean | null
          adjoining_to: string | null
          amenities: Json | null
          bed_config: string | null
          connecting_to: string | null
          created_at: string
          floor: string | null
          id: string
          ingest_run_id: string
          is_suite: boolean | null
          last_renovated: string | null
          last_synced_at: string
          max_occupancy: number | null
          pet_friendly: boolean | null
          property_id: string
          raw: Json | null
          room_number: string
          room_type: string | null
          smoking_allowed: boolean | null
          square_footage: number | null
          updated_at: string
          view_type: string | null
        }
        Insert: {
          accessible?: boolean | null
          adjoining_to?: string | null
          amenities?: Json | null
          bed_config?: string | null
          connecting_to?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          ingest_run_id: string
          is_suite?: boolean | null
          last_renovated?: string | null
          last_synced_at?: string
          max_occupancy?: number | null
          pet_friendly?: boolean | null
          property_id: string
          raw?: Json | null
          room_number: string
          room_type?: string | null
          smoking_allowed?: boolean | null
          square_footage?: number | null
          updated_at?: string
          view_type?: string | null
        }
        Update: {
          accessible?: boolean | null
          adjoining_to?: string | null
          amenities?: Json | null
          bed_config?: string | null
          connecting_to?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          ingest_run_id?: string
          is_suite?: boolean | null
          last_renovated?: string | null
          last_synced_at?: string
          max_occupancy?: number | null
          pet_friendly?: boolean | null
          property_id?: string
          raw?: Json | null
          room_number?: string
          room_type?: string | null
          smoking_allowed?: boolean | null
          square_footage?: number | null
          updated_at?: string
          view_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_rooms_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rooms_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_sync_alert_state: {
        Row: {
          last_alert_at: string | null
          last_reason: string | null
          last_recovery_at: string | null
          property_id: string
          state: string
          updated_at: string
        }
        Insert: {
          last_alert_at?: string | null
          last_reason?: string | null
          last_recovery_at?: string | null
          property_id: string
          state?: string
          updated_at?: string
        }
        Update: {
          last_alert_at?: string | null
          last_reason?: string | null
          last_recovery_at?: string | null
          property_id?: string
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_sync_alert_state_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_sync_echo: {
        Row: {
          property_id: string
          pushed_at: string
          pushed_value: string
          room_number: string
        }
        Insert: {
          property_id: string
          pushed_at?: string
          pushed_value: string
          room_number: string
        }
        Update: {
          property_id?: string
          pushed_at?: string
          pushed_value?: string
          room_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "pms_sync_echo_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_table_schemas: {
        Row: {
          columns: Json
          created_at: string
          natural_key: string[]
          notes: string | null
          reconcile_key_field: string | null
          snapshot_scope_default: string
          table_name: string
          time_grain: string
          updated_at: string
          write_strategy: string
        }
        Insert: {
          columns: Json
          created_at?: string
          natural_key: string[]
          notes?: string | null
          reconcile_key_field?: string | null
          snapshot_scope_default: string
          table_name: string
          time_grain?: string
          updated_at?: string
          write_strategy: string
        }
        Update: {
          columns?: Json
          created_at?: string
          natural_key?: string[]
          notes?: string | null
          reconcile_key_field?: string | null
          snapshot_scope_default?: string
          table_name?: string
          time_grain?: string
          updated_at?: string
          write_strategy?: string
        }
        Relationships: []
      }
      pms_unmapped_columns: {
        Row: {
          column_label: string
          first_seen_at: string
          last_seen_at: string
          occurrences: number
          property_id: string
          report_type: string
          resolved_at: string | null
          resolved_by: string | null
          sample_values: Json
          status: string
          target_table: string | null
        }
        Insert: {
          column_label: string
          first_seen_at?: string
          last_seen_at?: string
          occurrences?: number
          property_id: string
          report_type: string
          resolved_at?: string | null
          resolved_by?: string | null
          sample_values?: Json
          status?: string
          target_table?: string | null
        }
        Update: {
          column_label?: string
          first_seen_at?: string
          last_seen_at?: string
          occurrences?: number
          property_id?: string
          report_type?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sample_values?: Json
          status?: string
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_unmapped_columns_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_unmapped_columns_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_work_orders_v2: {
        Row: {
          actual_cost_cents: number | null
          area: string | null
          assigned_to: string | null
          category: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          estimated_cost_cents: number | null
          eta_back_in_service: string | null
          id: string
          ingest_run_id: string
          last_synced_at: string
          notes: string | null
          out_of_order: boolean | null
          parts_needed: string | null
          pms_work_order_id: string
          priority: string | null
          property_id: string
          raw: Json | null
          recurring_room: boolean | null
          reported_at: string | null
          reported_by: string | null
          resolved_at: string | null
          room_number: string | null
          source: string
          started_at: string | null
          status: string | null
          updated_at: string
          voice_metadata: Json | null
          voice_session_id: string | null
        }
        Insert: {
          actual_cost_cents?: number | null
          area?: string | null
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          estimated_cost_cents?: number | null
          eta_back_in_service?: string | null
          id?: string
          ingest_run_id: string
          last_synced_at?: string
          notes?: string | null
          out_of_order?: boolean | null
          parts_needed?: string | null
          pms_work_order_id: string
          priority?: string | null
          property_id: string
          raw?: Json | null
          recurring_room?: boolean | null
          reported_at?: string | null
          reported_by?: string | null
          resolved_at?: string | null
          room_number?: string | null
          source?: string
          started_at?: string | null
          status?: string | null
          updated_at?: string
          voice_metadata?: Json | null
          voice_session_id?: string | null
        }
        Update: {
          actual_cost_cents?: number | null
          area?: string | null
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          estimated_cost_cents?: number | null
          eta_back_in_service?: string | null
          id?: string
          ingest_run_id?: string
          last_synced_at?: string
          notes?: string | null
          out_of_order?: boolean | null
          parts_needed?: string | null
          pms_work_order_id?: string
          priority?: string | null
          property_id?: string
          raw?: Json | null
          recurring_room?: boolean | null
          reported_at?: string | null
          reported_by?: string | null
          resolved_at?: string | null
          room_number?: string | null
          source?: string
          started_at?: string | null
          status?: string | null
          updated_at?: string
          voice_metadata?: Json | null
          voice_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_work_orders_v2_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_work_orders_v2_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_work_orders_v2_voice_session_id_fkey"
            columns: ["voice_session_id"]
            isOneToOne: false
            referencedRelation: "agent_voice_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_writeback_recipes: {
        Row: {
          action_key: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          pms_family: string
          recipe: Json
          signature: string | null
          signed_at: string | null
          signed_with_key_id: string | null
          status: string
          updated_at: string
          verified_against: string
          version: number
        }
        Insert: {
          action_key: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          pms_family: string
          recipe: Json
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          updated_at?: string
          verified_against?: string
          version: number
        }
        Update: {
          action_key?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          pms_family?: string
          recipe?: Json
          signature?: string | null
          signed_at?: string | null
          signed_with_key_id?: string | null
          status?: string
          updated_at?: string
          verified_against?: string
          version?: number
        }
        Relationships: []
      }
      portfolio_properties: {
        Row: {
          assigned_at: string
          assigned_by_account_id: string | null
          created_at: string
          id: string
          organization_id: string
          portfolio_id: string
          property_id: string
          property_relationship_id: string
          removed_at: string | null
          removed_by_account_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by_account_id?: string | null
          created_at?: string
          id?: string
          organization_id: string
          portfolio_id: string
          property_id: string
          property_relationship_id: string
          removed_at?: string | null
          removed_by_account_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by_account_id?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          portfolio_id?: string
          property_id?: string
          property_relationship_id?: string
          removed_at?: string | null
          removed_by_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_properties_assigned_by_account_id_fkey"
            columns: ["assigned_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolio_properties_portfolio_scope_fkey"
            columns: ["portfolio_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "portfolio_properties_relationship_scope_fkey"
            columns: [
              "property_relationship_id",
              "organization_id",
              "property_id",
            ]
            isOneToOne: false
            referencedRelation: "organization_property_relationships"
            referencedColumns: ["id", "organization_id", "property_id"]
          },
          {
            foreignKeyName: "portfolio_properties_removed_by_account_id_fkey"
            columns: ["removed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolios: {
        Row: {
          created_at: string
          created_by_account_id: string | null
          id: string
          name: string
          organization_id: string
          parent_id: string | null
          portfolio_type: string
          status: string
          updated_at: string
          updated_by_account_id: string | null
        }
        Insert: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          name: string
          organization_id: string
          parent_id?: string | null
          portfolio_type?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Update: {
          created_at?: string
          created_by_account_id?: string | null
          id?: string
          name?: string
          organization_id?: string
          parent_id?: string | null
          portfolio_type?: string
          status?: string
          updated_at?: string
          updated_by_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolios_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolios_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portfolios_parent_same_organization_fkey"
            columns: ["parent_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "portfolios"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "portfolios_updated_by_account_id_fkey"
            columns: ["updated_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_log: {
        Row: {
          abs_error: number | null
          actual_value: number
          cleaning_event_id: string | null
          date: string
          id: string
          inventory_count_id: string | null
          layer: string
          logged_at: string
          model_run_id: string
          pinball_loss_p50: number | null
          predicted_value: number
          prediction_id: string
          property_id: string
          squared_error: number | null
        }
        Insert: {
          abs_error?: number | null
          actual_value: number
          cleaning_event_id?: string | null
          date: string
          id?: string
          inventory_count_id?: string | null
          layer: string
          logged_at?: string
          model_run_id: string
          pinball_loss_p50?: number | null
          predicted_value: number
          prediction_id: string
          property_id: string
          squared_error?: number | null
        }
        Update: {
          abs_error?: number | null
          actual_value?: number
          cleaning_event_id?: string | null
          date?: string
          id?: string
          inventory_count_id?: string | null
          layer?: string
          logged_at?: string
          model_run_id?: string
          pinball_loss_p50?: number | null
          predicted_value?: number
          prediction_id?: string
          property_id?: string
          squared_error?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_log_cleaning_event_id_fkey"
            columns: ["cleaning_event_id"]
            isOneToOne: false
            referencedRelation: "cleaning_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_log_inventory_count_property_fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "prediction_log_inventory_count_property_fkey"
            columns: ["inventory_count_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory_observed_rate_v"
            referencedColumns: ["newer_count_id", "property_id"]
          },
          {
            foreignKeyName: "prediction_log_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_log_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_overrides: {
        Row: {
          date: string
          id: string
          manual_headcount: number
          optimizer_recommendation: number
          optimizer_results_id: string | null
          outcome_actual_minutes_worked: number | null
          outcome_completed_on_time: boolean | null
          outcome_overtime_minutes: number | null
          outcome_recorded_at: string | null
          override_at: string
          override_by: string | null
          override_reason: string | null
          property_id: string
        }
        Insert: {
          date: string
          id?: string
          manual_headcount: number
          optimizer_recommendation: number
          optimizer_results_id?: string | null
          outcome_actual_minutes_worked?: number | null
          outcome_completed_on_time?: boolean | null
          outcome_overtime_minutes?: number | null
          outcome_recorded_at?: string | null
          override_at?: string
          override_by?: string | null
          override_reason?: string | null
          property_id: string
        }
        Update: {
          date?: string
          id?: string
          manual_headcount?: number
          optimizer_recommendation?: number
          optimizer_results_id?: string | null
          outcome_actual_minutes_worked?: number | null
          outcome_completed_on_time?: boolean | null
          outcome_overtime_minutes?: number | null
          outcome_recorded_at?: string | null
          override_at?: string
          override_by?: string | null
          override_reason?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_overrides_optimizer_results_id_fkey"
            columns: ["optimizer_results_id"]
            isOneToOne: false
            referencedRelation: "optimizer_results"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_overrides_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      preventive_tasks: {
        Row: {
          area: string | null
          completion_photo_path: string | null
          created_at: string
          equipment_id: string | null
          frequency_days: number
          id: string
          last_completed_at: string | null
          last_completed_by: string | null
          name: string
          notes: string | null
          property_id: string
        }
        Insert: {
          area?: string | null
          completion_photo_path?: string | null
          created_at?: string
          equipment_id?: string | null
          frequency_days: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name: string
          notes?: string | null
          property_id: string
        }
        Update: {
          area?: string | null
          completion_photo_path?: string | null
          created_at?: string
          equipment_id?: string | null
          frequency_days?: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name?: string
          notes?: string | null
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "preventive_tasks_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preventive_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_sentry_webhooks: {
        Row: {
          event_id: string
          metadata: Json
          processed_at: string
          webhook_kind: string
        }
        Insert: {
          event_id: string
          metadata?: Json
          processed_at?: string
          webhook_kind: string
        }
        Update: {
          event_id?: string
          metadata?: Json
          processed_at?: string
          webhook_kind?: string
        }
        Relationships: []
      }
      processed_twilio_webhooks: {
        Row: {
          message_sid: string
          metadata: Json
          processed_at: string
          property_id: string | null
          webhook_kind: string
        }
        Insert: {
          message_sid: string
          metadata?: Json
          processed_at?: string
          property_id?: string | null
          webhook_kind: string
        }
        Update: {
          message_sid?: string
          metadata?: Json
          processed_at?: string
          property_id?: string | null
          webhook_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "processed_twilio_webhooks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          alert_phone: string | null
          avg_occupancy: number
          brand: string | null
          business_date_cutoff_hour: number
          checkout_minutes: number
          climate_zone: string | null
          compliance_anomaly_sms_enabled: boolean
          created_at: string
          dashboard_stale_minutes: number
          enabled_sections: Json | null
          evening_forecast_time: string | null
          financials_alerts_sms_enabled: boolean
          hourly_wage: number
          housekeeping_setup: Json | null
          id: string
          inventory_ai_mode: string
          inventory_budget_mode: string
          inventory_tab_layout: Json | null
          is_test: boolean
          last_synced_at: string | null
          morning_briefing_time: string | null
          name: string
          nudge_subscription: Json | null
          onboarding_completed_at: string | null
          onboarding_prompt_shown_at: string | null
          onboarding_source: string
          onboarding_state: Json
          ordering_mode: string
          owner_id: string
          pms_connected: boolean | null
          pms_type: string | null
          pms_url: string | null
          pms_writeback_actions: string[]
          pms_writeback_enabled: boolean
          prep_minutes_per_activity: number
          property_kind: string
          region: string | null
          room_inventory: string[]
          scraper_window_end_hour: number
          scraper_window_start_hour: number
          services_enabled: Json
          shift_minutes: number
          size_tier: string | null
          stayover_day1_minutes: number | null
          stayover_day2_minutes: number | null
          stayover_minutes: number
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string
          timezone: string
          total_rooms: number
          total_staff_on_roster: number
          trial_ends_at: string | null
          updated_at: string
          weekly_budget: number | null
        }
        Insert: {
          alert_phone?: string | null
          avg_occupancy?: number
          brand?: string | null
          business_date_cutoff_hour?: number
          checkout_minutes?: number
          climate_zone?: string | null
          compliance_anomaly_sms_enabled?: boolean
          created_at?: string
          dashboard_stale_minutes?: number
          enabled_sections?: Json | null
          evening_forecast_time?: string | null
          financials_alerts_sms_enabled?: boolean
          hourly_wage?: number
          housekeeping_setup?: Json | null
          id?: string
          inventory_ai_mode?: string
          inventory_budget_mode?: string
          inventory_tab_layout?: Json | null
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_prompt_shown_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          ordering_mode?: string
          owner_id: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
          pms_writeback_actions?: string[]
          pms_writeback_enabled?: boolean
          prep_minutes_per_activity?: number
          property_kind?: string
          region?: string | null
          room_inventory?: string[]
          scraper_window_end_hour?: number
          scraper_window_start_hour?: number
          services_enabled?: Json
          shift_minutes?: number
          size_tier?: string | null
          stayover_day1_minutes?: number | null
          stayover_day2_minutes?: number | null
          stayover_minutes?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          timezone?: string
          total_rooms: number
          total_staff_on_roster?: number
          trial_ends_at?: string | null
          updated_at?: string
          weekly_budget?: number | null
        }
        Update: {
          alert_phone?: string | null
          avg_occupancy?: number
          brand?: string | null
          business_date_cutoff_hour?: number
          checkout_minutes?: number
          climate_zone?: string | null
          compliance_anomaly_sms_enabled?: boolean
          created_at?: string
          dashboard_stale_minutes?: number
          enabled_sections?: Json | null
          evening_forecast_time?: string | null
          financials_alerts_sms_enabled?: boolean
          hourly_wage?: number
          housekeeping_setup?: Json | null
          id?: string
          inventory_ai_mode?: string
          inventory_budget_mode?: string
          inventory_tab_layout?: Json | null
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name?: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_prompt_shown_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          ordering_mode?: string
          owner_id?: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
          pms_writeback_actions?: string[]
          pms_writeback_enabled?: boolean
          prep_minutes_per_activity?: number
          property_kind?: string
          region?: string | null
          room_inventory?: string[]
          scraper_window_end_hour?: number
          scraper_window_start_hour?: number
          services_enabled?: Json
          shift_minutes?: number
          size_tier?: string | null
          stayover_day1_minutes?: number | null
          stayover_day2_minutes?: number | null
          stayover_minutes?: number
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string
          timezone?: string
          total_rooms?: number
          total_staff_on_roster?: number
          trial_ends_at?: string | null
          updated_at?: string
          weekly_budget?: number | null
        }
        Relationships: []
      }
      property_sessions: {
        Row: {
          created_at: string
          current_browser_url: string | null
          daily_claude_cost_micros: number
          daily_claude_cost_resets_at: string
          last_alive_at: string | null
          last_successful_read_at: string | null
          notes: string | null
          paused_reason: string | null
          paused_until: string | null
          pms_family: string
          property_id: string
          read_failure_streak: number
          restart_count: number
          status: string
          updated_at: string
          worker_machine_id: string | null
        }
        Insert: {
          created_at?: string
          current_browser_url?: string | null
          daily_claude_cost_micros?: number
          daily_claude_cost_resets_at?: string
          last_alive_at?: string | null
          last_successful_read_at?: string | null
          notes?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          pms_family: string
          property_id: string
          read_failure_streak?: number
          restart_count?: number
          status?: string
          updated_at?: string
          worker_machine_id?: string | null
        }
        Update: {
          created_at?: string
          current_browser_url?: string | null
          daily_claude_cost_micros?: number
          daily_claude_cost_resets_at?: string
          last_alive_at?: string | null
          last_successful_read_at?: string | null
          notes?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          pms_family?: string
          property_id?: string
          read_failure_streak?: number
          restart_count?: number
          status?: string
          updated_at?: string
          worker_machine_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_shift_presets: {
        Row: {
          created_at: string
          department: string
          end_time: string
          id: string
          name: string
          property_id: string
          sort_order: number
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department: string
          end_time: string
          id?: string
          name: string
          property_id: string
          sort_order?: number
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string
          end_time?: string
          id?: string
          name?: string
          property_id?: string
          sort_order?: number
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_shift_presets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      prospects: {
        Row: {
          checklist: Json
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          expected_launch_date: string | null
          hotel_name: string
          id: string
          notes: string | null
          pms_type: string | null
          status: string
          updated_at: string
        }
        Insert: {
          checklist?: Json
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          expected_launch_date?: string | null
          hotel_name: string
          id?: string
          notes?: string | null
          pms_type?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          checklist?: Json
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          expected_launch_date?: string | null
          hotel_name?: string
          id?: string
          notes?: string | null
          pms_type?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      public_areas: {
        Row: {
          created_at: string
          floor: string
          frequency_days: number
          id: string
          is_rented_today: boolean | null
          locations: number
          minutes_per_clean: number
          name: string
          only_when_rented: boolean | null
          property_id: string
          start_date: string
        }
        Insert: {
          created_at?: string
          floor: string
          frequency_days: number
          id?: string
          is_rented_today?: boolean | null
          locations?: number
          minutes_per_clean: number
          name: string
          only_when_rented?: boolean | null
          property_id: string
          start_date: string
        }
        Update: {
          created_at?: string
          floor?: string
          frequency_days?: number
          id?: string
          is_rented_today?: boolean | null
          locations?: number
          minutes_per_clean?: number
          name?: string
          only_when_rented?: boolean | null
          property_id?: string
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "public_areas_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pull_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          id: string
          pms_type: string
          progress_pct: number
          property_id: string
          recipe_id: string | null
          result: Json | null
          scheduled_for: string
          started_at: string | null
          status: string
          step: string | null
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          id?: string
          pms_type: string
          progress_pct?: number
          property_id: string
          recipe_id?: string | null
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          id?: string
          pms_type?: string
          progress_pct?: number
          property_id?: string
          recipe_id?: string | null
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          step?: string | null
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pull_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pull_metrics: {
        Row: {
          created_at: string | null
          download_ms: number | null
          error_code: string | null
          id: string
          login_ms: number | null
          navigate_ms: number | null
          ok: boolean | null
          parse_ms: number | null
          property_id: string | null
          pull_type: string | null
          pulled_at: string | null
          rows: number | null
          total_ms: number | null
        }
        Insert: {
          created_at?: string | null
          download_ms?: number | null
          error_code?: string | null
          id?: string
          login_ms?: number | null
          navigate_ms?: number | null
          ok?: boolean | null
          parse_ms?: number | null
          property_id?: string | null
          pull_type?: string | null
          pulled_at?: string | null
          rows?: number | null
          total_ms?: number | null
        }
        Update: {
          created_at?: string | null
          download_ms?: number | null
          error_code?: string | null
          id?: string
          login_ms?: number | null
          navigate_ms?: number | null
          ok?: boolean | null
          parse_ms?: number | null
          property_id?: string | null
          pull_type?: string | null
          pulled_at?: string | null
          rows?: number | null
          total_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pull_metrics_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          item_id: string | null
          purchase_order_id: string
          qty_ordered: number
          qty_received: number
          unit_cost_cents: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          item_id?: string | null
          purchase_order_id: string
          qty_ordered: number
          qty_received?: number
          unit_cost_cents?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          item_id?: string | null
          purchase_order_id?: string
          qty_ordered?: number
          qty_received?: number
          unit_cost_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          po_number: string
          property_id: string
          received_at: string | null
          sent_at: string | null
          sent_to_email: string | null
          status: string
          subtotal_cents: number
          updated_at: string
          vendor_id: string | null
          vendor_name_snapshot: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          po_number: string
          property_id: string
          received_at?: string | null
          sent_at?: string | null
          sent_to_email?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name_snapshot?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          po_number?: string
          property_id?: string
          received_at?: string | null
          sent_at?: string | null
          sent_to_email?: string | null
          status?: string
          subtotal_cents?: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_task_templates: {
        Row: {
          active: boolean
          assigned_department: string | null
          assigned_staff_id: string | null
          cadence: string
          created_at: string
          created_by_staff_id: string | null
          id: string
          last_spawned_on: string | null
          priority: string
          property_id: string
          title: string
          updated_at: string
          weekday: number | null
        }
        Insert: {
          active?: boolean
          assigned_department?: string | null
          assigned_staff_id?: string | null
          cadence: string
          created_at?: string
          created_by_staff_id?: string | null
          id?: string
          last_spawned_on?: string | null
          priority?: string
          property_id: string
          title: string
          updated_at?: string
          weekday?: number | null
        }
        Update: {
          active?: boolean
          assigned_department?: string | null
          assigned_staff_id?: string | null
          cadence?: string
          created_at?: string
          created_by_staff_id?: string | null
          id?: string
          last_spawned_on?: string | null
          priority?: string
          property_id?: string
          title?: string
          updated_at?: string
          weekday?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recurring_task_templates_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_task_templates_created_by_staff_id_fkey"
            columns: ["created_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_task_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_favorites: {
        Row: {
          account_id: string
          created_at: string
          id: string
          property_id: string
          report_key: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          property_id: string
          report_key: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          property_id?: string
          report_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_favorites_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_favorites_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_preferences: {
        Row: {
          account_id: string
          cc_emails: Json
          channels: Json
          created_at: string
          delivery_time_local: string
          id: string
          paused_until: string | null
          property_id: string
          updated_at: string
          weekly_enabled: boolean
        }
        Insert: {
          account_id: string
          cc_emails?: Json
          channels?: Json
          created_at?: string
          delivery_time_local?: string
          id?: string
          paused_until?: string | null
          property_id: string
          updated_at?: string
          weekly_enabled?: boolean
        }
        Update: {
          account_id?: string
          cc_emails?: Json
          channels?: Json
          created_at?: string
          delivery_time_local?: string
          id?: string
          paused_until?: string | null
          property_id?: string
          updated_at?: string
          weekly_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "report_preferences_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_preferences_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_runs: {
        Row: {
          created_at: string
          email_send_status: Json
          generated_at: string
          id: string
          insight_text: string | null
          property_id: string
          recipients: Json
          report_date: string
          report_payload: Json | null
          report_type: string
        }
        Insert: {
          created_at?: string
          email_send_status?: Json
          generated_at?: string
          id?: string
          insight_text?: string | null
          property_id: string
          recipients?: Json
          report_date: string
          report_payload?: Json | null
          report_type: string
        }
        Update: {
          created_at?: string
          email_send_status?: Json
          generated_at?: string
          id?: string
          insight_text?: string | null
          property_id?: string
          recipients?: Json
          report_date?: string
          report_payload?: Json | null
          report_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      report_schedules: {
        Row: {
          cadence: string
          created_at: string
          created_by_account_id: string | null
          day_of_month: number | null
          day_of_week: number | null
          enabled: boolean
          hour_local: number
          id: string
          last_run_date: string | null
          last_run_status: string | null
          property_id: string
          range_kind: string
          recipients: Json
          report_key: string
          updated_at: string
        }
        Insert: {
          cadence: string
          created_at?: string
          created_by_account_id?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          hour_local?: number
          id?: string
          last_run_date?: string | null
          last_run_status?: string | null
          property_id: string
          range_kind?: string
          recipients?: Json
          report_key: string
          updated_at?: string
        }
        Update: {
          cadence?: string
          created_at?: string
          created_by_account_id?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          hour_local?: number
          id?: string
          last_run_date?: string | null
          last_run_status?: string | null
          property_id?: string
          range_kind?: string
          recipients?: Json
          report_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_schedules_created_by_account_id_fkey"
            columns: ["created_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      roadmap_items: {
        Row: {
          created_at: string
          description: string | null
          done_at: string | null
          id: string
          priority: number
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          done_at?: string | null
          id?: string
          priority?: number
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          done_at?: string | null
          id?: string
          priority?: number
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      role_changes: {
        Row: {
          account_id: string
          change_kind: string
          changed_at: string
          changed_by_account_id: string | null
          id: string
          new_role: string
          old_role: string | null
          property_id: string
          reason: string | null
        }
        Insert: {
          account_id: string
          change_kind?: string
          changed_at?: string
          changed_by_account_id?: string | null
          id?: string
          new_role: string
          old_role?: string | null
          property_id: string
          reason?: string | null
        }
        Update: {
          account_id?: string
          change_kind?: string
          changed_at?: string
          changed_by_account_id?: string | null
          id?: string
          new_role?: string
          old_role?: string | null
          property_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "role_changes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_changes_changed_by_account_id_fkey"
            columns: ["changed_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_changes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_assignments: {
        Row: {
          crew: string[]
          csv_pulled_at: string | null
          csv_room_snapshot: Json | null
          date: string
          property_id: string
          room_assignments: Json
          shift_starts: Json
          staff_names: Json
          updated_at: string
        }
        Insert: {
          crew?: string[]
          csv_pulled_at?: string | null
          csv_room_snapshot?: Json | null
          date: string
          property_id: string
          room_assignments?: Json
          shift_starts?: Json
          staff_names?: Json
          updated_at?: string
        }
        Update: {
          crew?: string[]
          csv_pulled_at?: string | null
          csv_room_snapshot?: Json | null
          date?: string
          property_id?: string
          room_assignments?: Json
          shift_starts?: Json
          staff_names?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_templates: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          payload: Json
          property_id: string
          scope: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          payload: Json
          property_id: string
          scope: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          payload?: Json
          property_id?: string
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_week_signoffs: {
        Row: {
          finished_at: string
          finished_by: string | null
          id: string
          property_id: string
          week_start: string
        }
        Insert: {
          finished_at?: string
          finished_by?: string | null
          id?: string
          property_id: string
          week_start: string
        }
        Update: {
          finished_at?: string
          finished_by?: string | null
          id?: string
          property_id?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_week_signoffs_finished_by_fkey"
            columns: ["finished_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_week_signoffs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_shifts: {
        Row: {
          created_at: string
          department: string
          end_time: string
          filled_by_history: Json
          id: string
          kind: string
          note: string | null
          preset_id: string | null
          property_id: string
          reason: string | null
          shift_date: string
          staff_id: string | null
          start_time: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department: string
          end_time: string
          filled_by_history?: Json
          id?: string
          kind?: string
          note?: string | null
          preset_id?: string | null
          property_id: string
          reason?: string | null
          shift_date: string
          staff_id?: string | null
          start_time: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string
          end_time?: string
          filled_by_history?: Json
          id?: string
          kind?: string
          note?: string | null
          preset_id?: string | null
          property_id?: string
          reason?: string | null
          shift_date?: string
          staff_id?: string | null
          start_time?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_shifts_preset_id_fkey"
            columns: ["preset_id"]
            isOneToOne: false
            referencedRelation: "property_shift_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_shifts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_shifts_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      // ── HAND-ADDED, PENDING MIGRATION APPLY ────────────────────────────
      // room_work (0355), staff_aliases and pms_dimension_values (0356) do
      // not exist in production yet, so `npm run db:types` cannot generate
      // them. These three blocks were written by hand from the migration DDL
      // so the code that reads and writes them type-checks. Re-run
      // `npm run db:types` immediately after applying 0354-0356 — that
      // regenerates the whole file from the live schema and replaces these.
      room_work: {
        Row: {
          assigned_source: string | null
          assigned_staff_id: string | null
          checklist_progress: string[]
          checklist_template_id: string | null
          completed_at: string | null
          created_at: string
          date: string
          dnd_active: boolean | null
          dnd_note: string | null
          exception_at: string | null
          exception_note: string | null
          exception_type: string | null
          help_requested: boolean
          housekeeper_note: string | null
          housekeeper_note_at: string | null
          inspected_at: string | null
          inspected_by: string | null
          is_paused: boolean
          is_rush: boolean
          issue_note: string | null
          manager_notes: string | null
          manager_notes_at: string | null
          manager_notes_by_account_id: string | null
          marked_for_inspection_at: string | null
          paused_at: string | null
          property_id: string
          room_number: string
          rush_due_by: string | null
          rush_duration_label: string | null
          rush_requested_by_account_id: string | null
          rush_set_at: string | null
          rush_set_by: string | null
          started_at: string | null
          status: string | null
          time_spent_minutes: number | null
          total_paused_seconds: number
          updated_at: string
        }
        Insert: {
          assigned_source?: string | null
          assigned_staff_id?: string | null
          checklist_progress?: string[]
          checklist_template_id?: string | null
          completed_at?: string | null
          created_at?: string
          date: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          paused_at?: string | null
          property_id: string
          room_number: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Update: {
          assigned_source?: string | null
          assigned_staff_id?: string | null
          checklist_progress?: string[]
          checklist_template_id?: string | null
          completed_at?: string | null
          created_at?: string
          date?: string
          dnd_active?: boolean | null
          dnd_note?: string | null
          exception_at?: string | null
          exception_note?: string | null
          exception_type?: string | null
          help_requested?: boolean
          housekeeper_note?: string | null
          housekeeper_note_at?: string | null
          inspected_at?: string | null
          inspected_by?: string | null
          is_paused?: boolean
          is_rush?: boolean
          issue_note?: string | null
          manager_notes?: string | null
          manager_notes_at?: string | null
          manager_notes_by_account_id?: string | null
          marked_for_inspection_at?: string | null
          paused_at?: string | null
          property_id?: string
          room_number?: string
          rush_due_by?: string | null
          rush_duration_label?: string | null
          rush_requested_by_account_id?: string | null
          rush_set_at?: string | null
          rush_set_by?: string | null
          started_at?: string | null
          status?: string | null
          time_spent_minutes?: number | null
          total_paused_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_work_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_work_staff_fk"
            columns: ["assigned_staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      staff_aliases: {
        Row: {
          alias_norm: string
          alias_raw: string
          first_seen_at: string
          id: string
          last_seen_at: string
          property_id: string
          seen_count: number
          source: string
          staff_id: string | null
        }
        Insert: {
          alias_raw: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          property_id: string
          seen_count?: number
          source: string
          staff_id?: string | null
        }
        Update: {
          alias_raw?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          property_id?: string
          seen_count?: number
          source?: string
          staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_aliases_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_aliases_staff_fk"
            columns: ["staff_id", "property_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id", "property_id"]
          },
        ]
      }
      pms_dimension_values: {
        Row: {
          canonical_code: string | null
          dimension: string
          first_seen_at: string
          id: string
          last_seen_at: string
          pms_family: string | null
          property_id: string
          raw_value: string
          resolved_at: string | null
          resolved_by: string | null
          seen_count: number
          value_norm: string
        }
        Insert: {
          canonical_code?: string | null
          dimension: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          pms_family?: string | null
          property_id: string
          raw_value: string
          resolved_at?: string | null
          resolved_by?: string | null
          seen_count?: number
        }
        Update: {
          canonical_code?: string | null
          dimension?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          pms_family?: string | null
          property_id?: string
          raw_value?: string
          resolved_at?: string | null
          resolved_by?: string | null
          seen_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "pms_dimension_values_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_credentials: {
        Row: {
          ca_login_url: string
          ca_password_encrypted: string | null
          ca_username_encrypted: string | null
          created_at: string
          is_active: boolean
          notes: string | null
          pms_login_email: string | null
          pms_type: string
          property_id: string
          report_inbox_hash: string | null
          report_inbox_local_encrypted: string | null
          report_raw_retention_days: number | null
          report_sender_domains: string[]
          scraper_instance: string
          updated_at: string
        }
        Insert: {
          ca_login_url?: string
          ca_password_encrypted?: string | null
          ca_username_encrypted?: string | null
          created_at?: string
          is_active?: boolean
          notes?: string | null
          pms_login_email?: string | null
          pms_type?: string
          property_id: string
          report_inbox_hash?: string | null
          report_inbox_local_encrypted?: string | null
          report_raw_retention_days?: number | null
          report_sender_domains?: string[]
          scraper_instance?: string
          updated_at?: string
        }
        Update: {
          ca_login_url?: string
          ca_password_encrypted?: string | null
          ca_username_encrypted?: string | null
          created_at?: string
          is_active?: boolean
          notes?: string | null
          pms_login_email?: string | null
          pms_type?: string
          property_id?: string
          report_inbox_hash?: string | null
          report_inbox_local_encrypted?: string | null
          report_raw_retention_days?: number | null
          report_sender_domains?: string[]
          scraper_instance?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scraper_credentials_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_session: {
        Row: {
          created_at: string
          property_id: string
          refreshed_at: string
          state: Json
        }
        Insert: {
          created_at?: string
          property_id: string
          refreshed_at?: string
          state: Json
        }
        Update: {
          created_at?: string
          property_id?: string
          refreshed_at?: string
          state?: Json
        }
        Relationships: [
          {
            foreignKeyName: "scraper_session_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_confirmations: {
        Row: {
          created_at: string
          language: string
          property_id: string
          responded_at: string | null
          sent_at: string | null
          shift_date: string
          sms_error: string | null
          sms_sent: boolean
          staff_id: string
          staff_name: string
          staff_phone: string
          status: string
          token: string
        }
        Insert: {
          created_at?: string
          language?: string
          property_id: string
          responded_at?: string | null
          sent_at?: string | null
          shift_date: string
          sms_error?: string | null
          sms_sent?: boolean
          staff_id: string
          staff_name: string
          staff_phone: string
          status?: string
          token: string
        }
        Update: {
          created_at?: string
          language?: string
          property_id?: string
          responded_at?: string | null
          sent_at?: string | null
          shift_date?: string
          sms_error?: string | null
          sms_sent?: boolean
          staff_id?: string
          staff_name?: string
          staff_phone?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_confirmations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_confirmations_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_jobs: {
        Row: {
          attempts: number
          body: string
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string
          max_attempts: number
          metadata: Json
          next_attempt_at: string
          property_id: string
          sent_at: string | null
          started_at: string | null
          status: string
          to_phone: string
          twilio_sid: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          body: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key: string
          max_attempts?: number
          metadata?: Json
          next_attempt_at?: string
          property_id: string
          sent_at?: string | null
          started_at?: string | null
          status?: string
          to_phone: string
          twilio_sid?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          body?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string
          max_attempts?: number
          metadata?: Json
          next_attempt_at?: string
          property_id?: string
          sent_at?: string | null
          started_at?: string | null
          status?: string
          to_phone?: string
          twilio_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          auth_user_id: string | null
          can_inspect: boolean
          created_at: string
          days_worked_this_week: number | null
          department: string | null
          hourly_wage: number | null
          id: string
          is_active: boolean | null
          is_scheduling_manager: boolean | null
          is_senior: boolean
          language: string
          last_paired_at: string | null
          max_days_per_week: number | null
          max_weekly_hours: number
          name: string
          phone: string | null
          phone_lookup: string | null
          property_id: string
          schedule_priority: string | null
          scheduled_today: boolean
          updated_at: string
          vacation_dates: string[] | null
          weekly_hours: number
        }
        Insert: {
          auth_user_id?: string | null
          can_inspect?: boolean
          created_at?: string
          days_worked_this_week?: number | null
          department?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean | null
          is_scheduling_manager?: boolean | null
          is_senior?: boolean
          language?: string
          last_paired_at?: string | null
          max_days_per_week?: number | null
          max_weekly_hours?: number
          name: string
          phone?: string | null
          phone_lookup?: string | null
          property_id: string
          schedule_priority?: string | null
          scheduled_today?: boolean
          updated_at?: string
          vacation_dates?: string[] | null
          weekly_hours?: number
        }
        Update: {
          auth_user_id?: string | null
          can_inspect?: boolean
          created_at?: string
          days_worked_this_week?: number | null
          department?: string | null
          hourly_wage?: number | null
          id?: string
          is_active?: boolean | null
          is_scheduling_manager?: boolean | null
          is_senior?: boolean
          language?: string
          last_paired_at?: string | null
          max_days_per_week?: number | null
          max_weekly_hours?: number
          name?: string
          phone?: string | null
          phone_lookup?: string | null
          property_id?: string
          schedule_priority?: string | null
          scheduled_today?: boolean
          updated_at?: string
          vacation_dates?: string[] | null
          weekly_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_breaks: {
        Row: {
          break_type: string
          business_date: string
          created_at: string
          ended_at: string | null
          id: string
          property_id: string
          staff_id: string
          started_at: string
        }
        Insert: {
          break_type: string
          business_date: string
          created_at?: string
          ended_at?: string | null
          id?: string
          property_id: string
          staff_id: string
          started_at: string
        }
        Update: {
          break_type?: string
          business_date?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          property_id?: string
          staff_id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_breaks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_kudos: {
        Row: {
          category: string | null
          created_at: string
          given_by: string | null
          given_by_name: string | null
          id: string
          message: string
          property_id: string
          staff_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          given_by?: string | null
          given_by_name?: string | null
          id?: string
          message: string
          property_id: string
          staff_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          given_by?: string | null
          given_by_name?: string | null
          id?: string
          message?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_kudos_given_by_fkey"
            columns: ["given_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_kudos_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_kudos_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_link_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          last_used_at: string | null
          property_id: string
          revoked_at: string | null
          staff_id: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          last_used_at?: string | null
          property_id: string
          revoked_at?: string | null
          staff_id: string
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          last_used_at?: string | null
          property_id?: string
          revoked_at?: string | null
          staff_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_link_tokens_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_link_tokens_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_magic_codes: {
        Row: {
          code: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          hashed_token: string
          property_id: string
          staff_id: string
        }
        Insert: {
          code: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          hashed_token: string
          property_id: string
          staff_id: string
        }
        Update: {
          code?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          hashed_token?: string
          property_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_magic_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_magic_codes_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staxis_support_sessions: {
        Row: {
          access_mode: string
          approved_by_account_id: string | null
          created_at: string
          ended_at: string | null
          ended_by_account_id: string | null
          expires_at: string
          id: string
          operator_account_id: string
          organization_id: string | null
          property_id: string | null
          reason: string
          scope_type: string
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          access_mode?: string
          approved_by_account_id?: string | null
          created_at?: string
          ended_at?: string | null
          ended_by_account_id?: string | null
          expires_at: string
          id?: string
          operator_account_id: string
          organization_id?: string | null
          property_id?: string | null
          reason: string
          scope_type: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          access_mode?: string
          approved_by_account_id?: string | null
          created_at?: string
          ended_at?: string | null
          ended_by_account_id?: string | null
          expires_at?: string
          id?: string
          operator_account_id?: string
          organization_id?: string | null
          property_id?: string | null
          reason?: string
          scope_type?: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staxis_support_sessions_approved_by_account_id_fkey"
            columns: ["approved_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_ended_by_account_id_fkey"
            columns: ["ended_by_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_operator_account_id_fkey"
            columns: ["operator_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staxis_support_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_processed_events: {
        Row: {
          event_id: string
          event_type: string
          metadata: Json | null
          processed_at: string
          property_id: string | null
        }
        Insert: {
          event_id: string
          event_type: string
          metadata?: Json | null
          processed_at?: string
          property_id?: string | null
        }
        Update: {
          event_id?: string
          event_type?: string
          metadata?: Json | null
          processed_at?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_processed_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      supply_predictions: {
        Row: {
          date: string
          features_snapshot: Json | null
          id: string
          model_run_id: string
          predicted_at: string
          predicted_minutes_p25: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75: number | null
          predicted_minutes_p90: number | null
          property_id: string
          room_number: string
          staff_id: string
        }
        Insert: {
          date: string
          features_snapshot?: Json | null
          id?: string
          model_run_id: string
          predicted_at?: string
          predicted_minutes_p25?: number | null
          predicted_minutes_p50: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          property_id: string
          room_number: string
          staff_id: string
        }
        Update: {
          date?: string
          features_snapshot?: Json | null
          id?: string
          model_run_id?: string
          predicted_at?: string
          predicted_minutes_p25?: number | null
          predicted_minutes_p50?: number
          predicted_minutes_p75?: number | null
          predicted_minutes_p90?: number | null
          property_id?: string
          room_number?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supply_predictions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supply_predictions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supply_predictions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      supply_priors: {
        Row: {
          cohort_key: string
          id: string
          n_hotels_contributing: number
          prior_minutes_per_event: number
          prior_strength: number
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_event: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          n_hotels_contributing?: number
          prior_minutes_per_event?: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      time_off_requests: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          deny_reason: string | null
          id: string
          property_id: string
          reason: string | null
          request_date: string
          staff_id: string
          status: string
          submitted_at: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          deny_reason?: string | null
          id?: string
          property_id: string
          reason?: string | null
          request_date: string
          staff_id: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          deny_reason?: string | null
          id?: string
          property_id?: string
          reason?: string | null
          request_date?: string
          staff_id?: string
          status?: string
          submitted_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_off_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_off_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_off_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      trusted_devices: {
        Row: {
          absolute_expires_at: string
          account_id: string
          created_at: string
          expires_at: string
          id: string
          ip: string | null
          last_seen_at: string
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          absolute_expires_at?: string
          account_id: string
          created_at?: string
          expires_at: string
          id?: string
          ip?: string | null
          last_seen_at?: string
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          absolute_expires_at?: string
          account_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip?: string | null
          last_seen_at?: string
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trusted_devices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_feedback: {
        Row: {
          admin_note: string | null
          category: string
          created_at: string
          decision_id: string | null
          eval_case_name: string | null
          id: string
          message: string
          property_id: string | null
          rating: number | null
          resolved_at: string | null
          status: string
          user_display_name: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          admin_note?: string | null
          category?: string
          created_at?: string
          decision_id?: string | null
          eval_case_name?: string | null
          id?: string
          message: string
          property_id?: string | null
          rating?: number | null
          resolved_at?: string | null
          status?: string
          user_display_name?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          admin_note?: string | null
          category?: string
          created_at?: string
          decision_id?: string | null
          eval_case_name?: string | null
          id?: string
          message?: string
          property_id?: string | null
          rating?: number | null
          resolved_at?: string | null
          status?: string
          user_display_name?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_feedback_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "agent_decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feedback_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          account_number: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          account_number?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          account_number?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      walkthrough_runs: {
        Row: {
          ended_at: string | null
          id: string
          property_id: string
          started_at: string
          status: string
          step_count: number
          task: string
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          property_id: string
          started_at?: string
          status?: string
          step_count?: number
          task: string
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          property_id?: string
          started_at?: string
          status?: string
          step_count?: number
          task?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "walkthrough_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkthrough_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_log: {
        Row: {
          id: string
          payload: Json
          source: string | null
          ts: string
        }
        Insert: {
          id?: string
          payload?: Json
          source?: string | null
          ts?: string
        }
        Update: {
          id?: string
          payload?: Json
          source?: string | null
          ts?: string
        }
        Relationships: []
      }
      week_publications: {
        Row: {
          created_at: string
          id: string
          property_id: string
          published_at: string
          published_by: string | null
          week_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id: string
          published_at?: string
          published_by?: string | null
          week_start: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string
          published_at?: string
          published_by?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "week_publications_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "week_publications_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          assigned_name: string | null
          assigned_to: string | null
          blocked_room: boolean | null
          ca_from_date: string | null
          ca_to_date: string | null
          ca_work_order_number: string | null
          completed_by_name: string | null
          completion_note: string | null
          completion_photo_path: string | null
          created_at: string | null
          description: string | null
          equipment_id: string | null
          id: string
          needs_pro: boolean
          notes: string | null
          photo_url: string | null
          pro_called_at: string | null
          pro_company: string | null
          pro_phone: string | null
          pro_trade: string | null
          property_id: string | null
          repair_cost: number | null
          resolved_at: string | null
          room_number: string | null
          severity: string | null
          source: string | null
          status: string | null
          submitted_by: string | null
          submitted_by_name: string | null
          submitter_photo_path: string | null
          submitter_role: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_name?: string | null
          assigned_to?: string | null
          blocked_room?: boolean | null
          ca_from_date?: string | null
          ca_to_date?: string | null
          ca_work_order_number?: string | null
          completed_by_name?: string | null
          completion_note?: string | null
          completion_photo_path?: string | null
          created_at?: string | null
          description?: string | null
          equipment_id?: string | null
          id?: string
          needs_pro?: boolean
          notes?: string | null
          photo_url?: string | null
          pro_called_at?: string | null
          pro_company?: string | null
          pro_phone?: string | null
          pro_trade?: string | null
          property_id?: string | null
          repair_cost?: number | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string | null
          source?: string | null
          status?: string | null
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_name?: string | null
          assigned_to?: string | null
          blocked_room?: boolean | null
          ca_from_date?: string | null
          ca_to_date?: string | null
          ca_work_order_number?: string | null
          completed_by_name?: string | null
          completion_note?: string | null
          completion_photo_path?: string | null
          created_at?: string | null
          description?: string | null
          equipment_id?: string | null
          id?: string
          needs_pro?: boolean
          notes?: string | null
          photo_url?: string | null
          pro_called_at?: string | null
          pro_company?: string | null
          pro_phone?: string | null
          pro_trade?: string | null
          property_id?: string | null
          repair_cost?: number | null
          resolved_at?: string | null
          room_number?: string | null
          severity?: string | null
          source?: string | null
          status?: string | null
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_jobs: {
        Row: {
          attempts: number
          claude_cost_micros: number
          completed_at: string | null
          created_at: string
          error: string | null
          error_detail: Json | null
          expires_at: string
          id: string
          idempotency_key: string
          kind: string
          last_attempt_at: string | null
          max_attempts: number
          paused_reason: string | null
          payload: Json
          property_id: string
          result: Json | null
          started_at: string | null
          status: string
          triggered_by: string | null
          worker_machine_id: string | null
        }
        Insert: {
          attempts?: number
          claude_cost_micros?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          expires_at?: string
          id?: string
          idempotency_key: string
          kind: string
          last_attempt_at?: string | null
          max_attempts?: number
          paused_reason?: string | null
          payload?: Json
          property_id: string
          result?: Json | null
          started_at?: string | null
          status?: string
          triggered_by?: string | null
          worker_machine_id?: string | null
        }
        Update: {
          attempts?: number
          claude_cost_micros?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          error_detail?: Json | null
          expires_at?: string
          id?: string
          idempotency_key?: string
          kind?: string
          last_attempt_at?: string | null
          max_attempts?: number
          paused_reason?: string | null
          payload?: Json
          property_id?: string
          result?: Json | null
          started_at?: string | null
          status?: string
          triggered_by?: string | null
          worker_machine_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workflow_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      cleaning_minutes_per_day_view: {
        Row: {
          date: string | null
          n_events: number | null
          property_id: string | null
          total_approved_minutes: number | null
          total_recorded_minutes: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      headcount_actuals_view: {
        Row: {
          actual_headcount: number | null
          date: string | null
          labels_complete: boolean | null
          no_show_count: number | null
          property_id: string | null
          scheduled_headcount: number | null
          unmarked_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_observed_rate_v: {
        Row: {
          days_elapsed: number | null
          discards_in_window: number | null
          item_id: string | null
          newer_count_id: string | null
          newer_counted_at: string | null
          newer_stock: number | null
          observed_rate: number | null
          older_counted_at: string | null
          older_stock: number | null
          orders_in_window: number | null
          property_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_item_property_fkey"
            columns: ["item_id", "property_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id", "property_id"]
          },
          {
            foreignKeyName: "inventory_counts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      item_canonical_name_view: {
        Row: {
          item_canonical_name: string | null
          item_id: string | null
          item_name: string | null
          property_id: string | null
        }
        Insert: {
          item_canonical_name?: never
          item_id?: string | null
          item_name?: string | null
          property_id?: string | null
        }
        Update: {
          item_canonical_name?: never
          item_id?: string | null
          item_name?: string | null
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_effective_property_access: {
        Row: {
          access_profile: string | null
          account_id: string | null
          expires_at: string | null
          grant_id: string | null
          membership_id: string | null
          organization_id: string | null
          property_id: string | null
          property_relationship_id: string | null
          scope_type: string | null
          source: string | null
          starts_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      pg_tables_policy_coverage: {
        Row: {
          has_tenant_column: boolean | null
          policy_count: number | null
          rls_enabled: boolean | null
          schemaname: unknown
          tablename: unknown
        }
        Relationships: []
      }
      pg_tables_rls_status: {
        Row: {
          forcerowsecurity: boolean | null
          rowsecurity: boolean | null
          schemaname: unknown
          tablename: unknown
        }
        Relationships: []
      }
      pms_channel_performance_current: {
        Row: {
          as_of: string | null
          average_lead_time_days: number | null
          average_length_of_stay: number | null
          bookings_count: number | null
          business_date: string | null
          business_date_source: string | null
          cancellation_rate_pct: number | null
          channel: string | null
          commission_paid_cents: number | null
          commission_rate_pct: number | null
          created_at: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          property_id: string | null
          raw: Json | null
          revenue_cents: number | null
          rooms_sold: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_channel_performance_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_channel_performance_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_delivery_signal_v1: {
        Row: {
          feed_key: string | null
          last_delivery_at: string | null
          property_id: string | null
        }
        Relationships: []
      }
      pms_feed_health_v1: {
        Row: {
          alert_channel: string | null
          cadence_kind: string | null
          enabled: boolean | null
          expected_at_local: string | null
          expected_every_minutes: number | null
          feed_key: string | null
          grace_minutes: number | null
          label: string | null
          last_delivery_at: string | null
          last_report_at: string | null
          last_signal_at: string | null
          legacy_target: string | null
          minutes_late: number | null
          open_quarantine_count: number | null
          open_unmapped_count: number | null
          property_id: string | null
          report_type: string | null
          required: boolean | null
          state: string | null
          target_table: string | null
          timezone: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_catalog_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
          {
            foreignKeyName: "pms_feed_expectations_feed_key_fkey"
            columns: ["feed_key"]
            isOneToOne: false
            referencedRelation: "pms_feed_catalog"
            referencedColumns: ["feed_key"]
          },
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_feed_table_signal_v1: {
        Row: {
          last_report_at: string | null
          property_id: string | null
          target_table: string | null
        }
        Relationships: []
      }
      pms_forecast_daily_current: {
        Row: {
          booking_pace_indicator: string | null
          created_at: string | null
          forecast_date: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          projected_adr_cents: number | null
          projected_arrivals: number | null
          projected_departures: number | null
          projected_in_house: number | null
          projected_occupancy_pct: number | null
          projected_revenue_cents: number | null
          projected_revpar_cents: number | null
          property_id: string | null
          raw: Json | null
          snapshot_date: string | null
          vs_same_day_last_year_pct: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_forecast_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_forecast_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_in_house_snapshot: {
        Row: {
          arrivals_remaining_today: number | null
          cancellations_today: number | null
          captured_at: string | null
          checked_in_today_count: number | null
          checked_out_today_count: number | null
          departures_remaining_today: number | null
          has_error: boolean | null
          ingest_run_id: string | null
          last_error: string | null
          last_good_at: string | null
          last_synced_at: string | null
          no_shows_today: number | null
          property_id: string | null
          raw: Json | null
          revenue_today_so_far_cents: number | null
          special_needs_guests_in_house: number | null
          total_guests_in_house: number | null
          total_occupied_rooms: number | null
          total_ooo: number | null
          total_vacant_clean: number | null
          total_vacant_dirty: number | null
          vip_guests_in_house: number | null
          walk_ins_today: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_in_house_snapshot_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_in_house_snapshot_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_payments_daily_current: {
        Row: {
          as_of: string | null
          business_date: string | null
          business_date_source: string | null
          captured_at: string | null
          card_collected_cents: number | null
          cash_collected_cents: number | null
          created_at: string | null
          deposits_collected_cents: number | null
          id: string | null
          ingest_run_id: string | null
          property_id: string | null
          raw: Json | null
          total_collected_cents: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_payments_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_payments_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_property_health_v1: {
        Row: {
          feeds_learning: number | null
          feeds_live: number | null
          feeds_stale: number | null
          feeds_total: number | null
          feeds_unavailable: number | null
          newest_signal_at: string | null
          oldest_signal_at: string | null
          open_quarantine_total: number | null
          open_unmapped_total: number | null
          property_id: string | null
          required_feeds_degraded: number | null
          worst_minutes_late: number | null
          worst_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_feed_expectations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_quarantine_rollup_v1: {
        Row: {
          deliveries_affected: number | null
          fingerprint: string | null
          first_seen_at: string | null
          last_seen_at: string | null
          latest_reason_detail: string | null
          open_rows: number | null
          property_id: string | null
          reason_code: string | null
          report_type: string | null
          target_table: string | null
          total_occurrences: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_ingest_quarantine_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_ingest_quarantine_target_table_fkey"
            columns: ["target_table"]
            isOneToOne: false
            referencedRelation: "pms_table_schemas"
            referencedColumns: ["table_name"]
          },
        ]
      }
      pms_rates_and_inventory_current: {
        Row: {
          as_of: string | null
          available_rooms: number | null
          captured_at: string | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          property_id: string | null
          rate_amount_cents: number | null
          rate_loaded_in_channel_manager: boolean | null
          rate_parity_status: Json | null
          rate_plan: string | null
          raw: Json | null
          room_type: string | null
          stay_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_rates_and_inventory_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_rates_and_inventory_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pms_revenue_daily_current: {
        Row: {
          adjustments_cents: number | null
          adr_cents: number | null
          ancillary_revenue_cents: number | null
          as_of: string | null
          available_rooms: number | null
          business_date: string | null
          business_date_source: string | null
          channel_commission_breakdown: Json | null
          comps_cents: number | null
          created_at: string | null
          discounts_cents: number | null
          fnb_revenue_cents: number | null
          goppar_cents: number | null
          gross_operating_profit_cents: number | null
          group_revenue_cents: number | null
          id: string | null
          ingest_run_id: string | null
          last_synced_at: string | null
          occupancy_pct: number | null
          occupied_rooms: number | null
          ooo_rooms: number | null
          ota_commission_paid_cents: number | null
          property_id: string | null
          raw: Json | null
          refunds_cents: number | null
          revpar_cents: number | null
          rooms_revenue_cents: number | null
          taxes_collected: Json | null
          total_revenue_cents: number | null
          transient_revenue_cents: number | null
          updated_at: string | null
          walk_in_revenue_cents: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pms_revenue_daily_ingest_run_fk"
            columns: ["ingest_run_id"]
            isOneToOne: false
            referencedRelation: "pms_ingest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pms_revenue_daily_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_credentials_decrypted: {
        Row: {
          ca_login_url: string | null
          ca_password: string | null
          ca_username: string | null
          created_at: string | null
          is_active: boolean | null
          notes: string | null
          pms_type: string | null
          property_id: string | null
          scraper_instance: string | null
          updated_at: string | null
        }
        Insert: {
          ca_login_url?: string | null
          ca_password?: never
          ca_username?: never
          created_at?: string | null
          is_active?: boolean | null
          notes?: string | null
          pms_type?: string | null
          property_id?: string | null
          scraper_instance?: string | null
          updated_at?: string | null
        }
        Update: {
          ca_login_url?: string | null
          ca_password?: never
          ca_username?: never
          created_at?: string | null
          is_active?: boolean | null
          notes?: string | null
          pms_type?: string | null
          property_id?: string | null
          scraper_instance?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scraper_credentials_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      walkthrough_runs_daily: {
        Row: {
          avg_steps_to_done: number | null
          cannot_help: number | null
          completed: number | null
          day: string | null
          errored: number | null
          hit_step_cap: number | null
          still_active: number | null
          timed_out: number | null
          total: number | null
          user_stopped: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _activity_log_resolve_actor: {
        Args: { p_staff_id: string; p_user_id: string }
        Returns: {
          account_id: string
          actor_name: string
          actor_role: string
        }[]
      }
      _activity_log_write: {
        Args: {
          p_actor_staff_id: string
          p_actor_user_id: string
          p_description: string
          p_event_category: string
          p_event_type: string
          p_metadata: Json
          p_occurred_at: string
          p_property_id: string
          p_source: string
          p_source_event_id: string
          p_target_id: string
          p_target_label: string
          p_target_type: string
        }
        Returns: undefined
      }
      _pms_lineage_tables: { Args: never; Returns: string[] }
      _staxis_can_delegate_organization_access: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_organization_id: string
          p_portfolio_id: string
          p_property_id: string
          p_scope_type: string
        }
        Returns: boolean
      }
      _staxis_lock_organization: {
        Args: { p_organization_id: string }
        Returns: undefined
      }
      _staxis_reconcile_legacy_organization_access: {
        Args: { p_actor_account_id?: string; p_property_id?: string }
        Returns: Json
      }
      _staxis_unique_index_columns: {
        Args: { p_rel: unknown }
        Returns: string[][]
      }
      claim_idempotency_key: {
        Args: { p_key: string; p_pid?: string; p_route: string }
        Returns: {
          claimed: boolean
          existing_response: Json
          existing_route: string
          existing_status: number
        }[]
      }
      claim_pms_auth_code: {
        Args: {
          p_max_age_seconds?: number
          p_not_before?: string
          p_property_id: string
        }
        Returns: {
          code: string
          id: string
        }[]
      }
      cleanup_idempotency_log: { Args: never; Returns: number }
      complete_inspection_atomic: {
        Args: {
          p_correction_note: string
          p_correction_notice_sent_at: string
          p_escalated: boolean
          p_escalation_reason: string
          p_failed_items: Json
          p_inspection_id: string
          p_notes: string
          p_passed_items: Json
          p_property_id: string
          p_result: string
        }
        Returns: {
          checklist_id: string | null
          cleaning_task_id: string | null
          completed_at: string | null
          correction_notice_sent_at: string | null
          created_at: string
          escalated: boolean
          escalation_reason: string | null
          failed_items: Json
          housekeeper_staff_id: string | null
          id: string
          inspector_staff_id: string | null
          notes: string | null
          parent_inspection_id: string | null
          passed_items: Json
          property_id: string
          recheck_inspection_id: string | null
          result: string
          room_id: string | null
          room_number: string
          started_at: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "inspections"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      decrypt_pms_credential: { Args: { ciphertext: string }; Returns: string }
      encrypt_pms_credential: { Args: { plaintext: string }; Returns: string }
      exec_sql: { Args: { sql: string }; Returns: Json }
      expire_stale_help_requests: {
        Args: never
        Returns: {
          id: string
          screenshot_storage_path: string
        }[]
      }
      is_admin_user: { Args: { uid: string }; Returns: boolean }
      mfa_verified_or_grace: { Args: never; Returns: boolean }
      pms_delivery_quarantine_count: {
        Args: { p_delivery_id: string }
        Returns: number
      }
      pms_feed_minutes_late: {
        Args: {
          p_cadence_kind: string
          p_expected_at_local: string
          p_expected_every_minutes: number
          p_last_signal_at: string
          p_now: string
          p_timezone: string
        }
        Returns: number
      }
      pms_lineage_gaps: {
        Args: never
        Returns: {
          missing_table: string
          reason: string
        }[]
      }
      project_property_counts_v1: {
        Args: { p_property_id: string; p_target_date: string }
        Returns: {
          arrival_room_numbers: string[]
          arrivals: number
          checkout_room_numbers: string[]
          checkouts: number
          ooo: number
          stayover_arrival_day: number
          stayover_day1: number
          stayover_day1_room_numbers: string[]
          stayover_day2: number
          stayover_unknown: number
          stayovers: number
          total_rooms: number
          vacant_clean: number
          vacant_dirty: number
        }[]
      }
      promote_shadow_model_run: {
        Args: { p_active_id: string; p_shadow_id: string }
        Returns: undefined
      }
      reassign_cleaning_task: {
        Args: {
          p_assigned_by_user: string
          p_property_id: string
          p_reason: string
          p_task_id: string
          p_to_housekeeper_id: string
        }
        Returns: {
          assignee_id: string
          noop: boolean
          task_id: string
        }[]
      }
      replace_labor_wage_settings: {
        Args: { p_property_id: string; p_rows: Json; p_updated_by: string }
        Returns: undefined
      }
      staxis_2fa_enabled: { Args: never; Returns: boolean }
      staxis_accept_organization_invitation: {
        Args: { p_account_id: string; p_token_hash: string }
        Returns: {
          grant_id: string
          membership_id: string
        }[]
      }
      staxis_activate_ai_feature_config: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_config_id: string
          p_expected_active_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_activate_prompt: {
        Args: { p_id: string; p_pms_family?: string; p_role: string }
        Returns: undefined
      }
      staxis_apply_onboarding_join_code_transition: {
        Args: {
          p_code_id: string
          p_hotel_id: string
          p_request_id?: string
          p_transition: string
        }
        Returns: Json
      }
      staxis_active_property_ids_for_nudges: {
        Args: { p_window_days?: number }
        Returns: {
          property_id: string
        }[]
      }
      staxis_api_limit_cleanup: { Args: never; Returns: number }
      staxis_api_limit_hit: {
        Args: {
          p_endpoint: string
          p_hour_bucket: string
          p_property_id: string
        }
        Returns: number
      }
      staxis_append_inventory_audit_event: {
        Args: {
          p_action: string
          p_actor_name: string
          p_actor_user_id: string
          p_after_state: Json
          p_before_state: Json
          p_dedupe_key: string
          p_details: Json
          p_entity_id: string
          p_entity_key: string
          p_entity_type: string
          p_financial_details: Json
          p_occurred_at: string
          p_property_id: string
          p_request_id: string
          p_source_id: string
          p_source_table: string
          p_summary: Json
        }
        Returns: string
      }
      staxis_apply_conversation_summary: {
        Args: {
          p_conversation_id: string
          p_cost_usd: number
          p_model: string
          p_model_id: string
          p_summarized_message_ids: string[]
          p_summary_content: string
          p_tokens_in: number
          p_tokens_out: number
        }
        Returns: string
      }
      staxis_archive_conversation: {
        Args: { p_conversation_id: string; p_min_age_days?: number }
        Returns: number
      }
      staxis_bootstrap_organization_leader_invitation: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_email: string
          p_expires_at?: string
          p_job_category: string
          p_job_title: string
          p_organization_id: string
          p_token_hash: string
        }
        Returns: string
      }
      staxis_business_date: {
        Args: { p_instant: string; p_property_id: string }
        Returns: string
      }
      staxis_cancel_agent_spend: {
        Args: { p_reservation_id: string }
        Returns: undefined
      }
      staxis_cancel_organization_invitation: {
        Args: {
          p_actor_account_id: string
          p_invitation_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_cancel_phone_pairing_send: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
        }
        Returns: boolean
      }
      staxis_change_hotel_team_role_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_display_name: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
          p_new_display_name: string
          p_new_role: string
          p_request_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      staxis_change_organization_membership_status: {
        Args: {
          p_action: string
          p_actor_account_id: string
          p_membership_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_check_ownership_transfer_replay: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_operation_id: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_claim_account_lifecycle_intent: {
        Args: {
          p_lease_seconds?: number
          p_operation_id: string
          p_processor_token: string
        }
        Returns: Json
      }
      staxis_claim_join_code_slot: {
        Args: { p_expected_used_count: number; p_id: string }
        Returns: Json
      }
      staxis_claim_next_job: {
        Args: { p_worker_id: string }
        Returns: {
          force_remap: boolean
          id: string
          pms_type: string
          property_id: string
          started_at: string
          worker_id: string
        }[]
      }
      staxis_claim_next_pull_job: {
        Args: { p_worker_id: string }
        Returns: {
          id: string
          pms_type: string
          property_id: string
          recipe_id: string
          scheduled_for: string
          started_at: string
          worker_id: string
        }[]
      }
      staxis_claim_password_signin_proof: {
        Args: { p_user_id: string }
        Returns: string
      }
      staxis_claim_phone_pairing: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_token_hash: string
          p_phone_ip?: string
          p_phone_user_agent?: string
        }
        Returns: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string
          newly_claimed: boolean
          pairing_id: string
          send_count: number
          send_reservation_id: string
        }[]
      }
      staxis_claim_sms_jobs: {
        Args: { p_limit: number }
        Returns: {
          attempts: number
          body: string
          id: string
          idempotency_key: string
          max_attempts: number
          metadata: Json
          property_id: string
          to_phone: string
        }[]
      }
      staxis_cleanup_phone_pairings: {
        Args: { p_account_id: string }
        Returns: number
      }
      staxis_close_inventory_month_close: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_manual_purchase_cents: number
          p_month_start: string
          p_notes: string
          p_property_id: string
          p_purchase_source: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_commit_account_lifecycle_intent: {
        Args: {
          p_operation_id: string
          p_processor_token: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_company_access_feed: {
        Args: { p_actor_account_id: string; p_limit?: number }
        Returns: Json
      }
      staxis_compensate_account_lifecycle_intent: {
        Args: {
          p_operation_id: string
          p_processor_token: string
          p_reason: string
        }
        Returns: Json
      }
      staxis_complete_phone_pairing: {
        Args: {
          p_completion_token_hash: string
          p_device_expires_at: string
          p_device_token_hash: string
          p_ip?: string
          p_session_id: string
          p_user_agent?: string
          p_user_id: string
        }
        Returns: string
      }
      staxis_correct_inventory_delivery: {
        Args: {
          p_corrected_at: string
          p_corrected_by: string
          p_lines: Json
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_correct_inventory_delivery_0334_impl: {
        Args: {
          p_corrected_at: string
          p_corrected_by: string
          p_lines: Json
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_count_finalize_failures_today: { Args: never; Returns: number }
      staxis_count_stale_reservations: {
        Args: { p_max_age_minutes?: number }
        Returns: number
      }
      staxis_count_swept_today: { Args: never; Returns: number }
      staxis_create_ai_feature_config: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_change_reason: string
          p_enabled: boolean
          p_fallback_model_id: string
          p_fallback_provider: string
          p_feature_key: string
          p_parameters: Json
          p_parent_id: string
          p_primary_model_id: string
          p_primary_provider: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_create_inventory_vendor: {
        Args: {
          p_account_number: string
          p_actor_id: string
          p_actor_name: string
          p_email: string
          p_is_active: boolean
          p_name: string
          p_notes: string
          p_phone: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_create_organization: {
        Args: {
          p_actor_account_id: string
          p_name: string
          p_organization_type: string
        }
        Returns: string
      }
      staxis_create_organization_access_request: {
        Args: {
          p_actor_account_id: string
          p_membership_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_reason: string
          p_requested_access_profile: string
          p_scope_type: string
        }
        Returns: string
      }
      staxis_create_organization_invitation: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_email: string
          p_expires_at?: string
          p_grant_expires_at?: string
          p_job_category: string
          p_job_title: string
          p_organization_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_scope_type: string
          p_token_hash: string
        }
        Returns: string
      }
      staxis_create_structured_issue: {
        Args: {
          p_action: string
          p_item: string
          p_location_detail: string
          p_note: string
          p_property_id: string
          p_reporter_staff_id: string
          p_room_number: string
          p_severity: string
        }
        Returns: string
      }
      staxis_cua_increment_spend: {
        Args: { p_micros: number; p_property_id: string }
        Returns: {
          new_total_micros: number
          resets_at: string
          status: string
        }[]
      }
      staxis_delete_property_and_legacy_accounts: {
        Args: {
          p_actor_account_id: string
          p_confirmed_name?: string
          p_property_id: string
        }
        Returns: Json
      }
      staxis_enqueue_pms_write: {
        Args: {
          p_action_key: string
          p_allow_enqueue: boolean
          p_changed_by: string
          p_payload: Json
          p_property_id: string
          p_room_number: string
          p_status: string
        }
        Returns: string
      }
      staxis_enqueue_property_pull: {
        Args: {
          p_pms_type: string
          p_property_id: string
          p_scheduled_for?: string
        }
        Returns: string
      }
      staxis_finalize_agent_spend: {
        Args: {
          p_actual_usd: number
          p_cached_input_tokens: number
          p_conversation_id: string
          p_model: string
          p_model_id: string
          p_reservation_id: string
          p_tokens_in: number
          p_tokens_out: number
        }
        Returns: undefined
      }
      staxis_finalize_join_code_signup: {
        Args: {
          p_auth_user_id: string
          p_code: string
          p_code_id: string
          p_display_name: string
          p_expected_used_count: number
          p_hotel_id: string
          p_language: string
          p_phone: string | null
          p_request_id: string
          p_requested_role: string
          p_username: string
        }
        Returns: Json
      }
      staxis_finalize_phone_pairing_send: {
        Args: {
          p_challenge_token_hash: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
        }
        Returns: string
      }
      staxis_forget_memory: {
        Args: {
          p_property_id: string
          p_scope: string
          p_subject_account_id: string
          p_topic: string
        }
        Returns: number
      }
      staxis_get_account_lifecycle_intent: {
        Args: { p_operation_id: string }
        Returns: Json
      }
      staxis_get_or_create_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_get_or_set_shift_start: {
        Args: {
          p_date: string
          p_default_at: string
          p_property: string
          p_staff: string
        }
        Returns: string
      }
      staxis_grant_organization_access: {
        Args: {
          p_access_profile: string
          p_actor_account_id: string
          p_expires_at?: string
          p_membership_id: string
          p_portfolio_id?: string
          p_property_id?: string
          p_scope_type: string
          p_source?: string
          p_starts_at?: string
        }
        Returns: string
      }
      staxis_grant_property_access: {
        Args: { p_account_id: string; p_hotel_id: string }
        Returns: number
      }
      staxis_heal_conversation_counters: {
        Args: { p_dry_run?: boolean }
        Returns: {
          actual_msg_count: number
          actual_unsum_count: number
          conversation_id: string
          healed: boolean
          stored_msg_count: number
          stored_unsum_count: number
        }[]
      }
      staxis_insert_draft_recipe: {
        Args: {
          p_learned_by_property_id: string
          p_notes: string
          p_pms_type: string
          p_recipe: Json
        }
        Returns: {
          id: string
          version: number
        }[]
      }
      staxis_install_cold_start_model_run: {
        Args: {
          p_hyperparameters: Json
          p_item_id: string
          p_model_version: string
          p_posterior_params: Json
          p_property_id: string
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_demand_supply_cold_start: {
        Args: {
          p_hyperparameters: Json
          p_layer: string
          p_model_version: string
          p_posterior_params: Json
          p_property_id: string
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_housekeeping_model_run: {
        Args: {
          p_fields: Json
          p_layer: string
          p_property_id: string
          p_should_activate: boolean
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_install_inventory_model_run: {
        Args: {
          p_fields: Json
          p_item_id: string
          p_property_id: string
          p_should_activate: boolean
          p_should_shadow: boolean
        }
        Returns: {
          model_run_id: string
          ok: boolean
          reason: string
        }[]
      }
      staxis_inventory_archive_zero_evidence: {
        Args: { p_item_id: string; p_property_id: string }
        Returns: {
          activity_sequence: number
          evidence_at: string
          evidence_id: string
          evidence_kind: string
          unit_cost: number
        }[]
      }
      staxis_inventory_audit_actor_name: {
        Args: { p_user_id: string }
        Returns: string
      }
      staxis_inventory_has_stock_evidence: {
        Args: { p_item_id: string; p_property_id: string }
        Returns: boolean
      }
      staxis_inventory_usage_budget_snapshot: {
        Args: { p_month_start: string; p_property_id: string }
        Returns: {
          usage_budget_by_key: Json
          usage_budget_mode: string
          usage_budget_total_cents: number
        }[]
      }
      staxis_list_inventory_archive_readiness: {
        Args: { p_item_ids: string[]; p_property_id: string }
        Returns: Json
      }
      staxis_list_inventory_audit_events: {
        Args: {
          p_before_sequence: number
          p_include_financials: boolean
          p_limit: number
          p_property_id: string
        }
        Returns: Json
      }
      staxis_list_inventory_delivery_corrections: {
        Args: {
          p_include_financials?: boolean
          p_property_id: string
          p_root_order_ids: string[]
        }
        Returns: Json
      }
      staxis_list_inventory_delivery_corrections_0334_impl: {
        Args: {
          p_include_financials?: boolean
          p_property_id: string
          p_root_order_ids: string[]
        }
        Returns: Json
      }
      staxis_list_inventory_financial_evidence: {
        Args: { p_property_id: string }
        Returns: Json
      }
      staxis_list_normalized_organization_owner_account_ids: {
        Args: { p_account_ids: string[] }
        Returns: string[]
      }
      staxis_load_and_record_user_turn: {
        Args: {
          p_conversation_id: string
          p_user_id: string
          p_user_message: string
        }
        Returns: Json
      }
      staxis_lock_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      staxis_lock_load_and_record_user_turn: {
        Args: {
          p_conversation_id: string
          p_property_id: string
          p_user_account_id: string
          p_user_message: string
        }
        Returns: {
          history_rows: Json
          ok: boolean
          reason: string
        }[]
      }
      staxis_merge_services: {
        Args: { p_patch: Json; p_property_id: string }
        Returns: Json
      }
      staxis_mint_privileged_onboarding_join_code: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id: string
          p_role: string
        }
        Returns: Json
      }
      staxis_note_account_lifecycle_attempt: {
        Args: { p_error: string; p_operation_id: string }
        Returns: Json
      }
      staxis_parse_finite_numeric: {
        Args: { p_label: string; p_value: string }
        Returns: number
      }
      staxis_pms_purge_observations: {
        Args: { p_before: string; p_table: string }
        Returns: number
      }
      staxis_pms_registry_violations: {
        Args: never
        Returns: {
          table_name: string
          violation: string
        }[]
      }
      staxis_post_notice: {
        Args: {
          p_body_en: string
          p_body_es: string
          p_body_ht: string
          p_body_tl: string
          p_body_vi: string
          p_expires_at: string
          p_pinned: boolean
          p_posted_by_account_id: string
          p_property_id: string
        }
        Returns: string
      }
      staxis_property_section_enabled: {
        Args: { p_property_id: string; p_section: string }
        Returns: boolean
      }
      staxis_purge_old_pull_jobs: { Args: never; Returns: number }
      staxis_realtime_columns: {
        Args: never
        Returns: {
          allowed_columns: string[]
          table_name: string
        }[]
      }
      staxis_realtime_publication_tables: {
        Args: never
        Returns: {
          tablename: string
        }[]
      }
      staxis_reap_stale_jobs: { Args: never; Returns: number }
      staxis_reap_stale_pull_jobs: { Args: never; Returns: number }
      staxis_receive_inventory_delivery: {
        Args: {
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_inventory_delivery_0334_impl: {
        Args: {
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_inventory_delivery_for_actor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_lines: Json
          p_notes: string
          p_property_id: string
          p_received_at: string
          p_request_id: string
          p_vendor_name: string
        }
        Returns: Json
      }
      staxis_receive_po_lines: {
        Args: { p_lines: Json; p_po_id: string; p_property_id: string }
        Returns: undefined
      }
      staxis_receive_po_lines_v2: {
        Args: { p_lines: Json; p_po_id: string; p_property_id: string }
        Returns: undefined
      }
      staxis_reconcile_legacy_organization_access: {
        Args: { p_actor_account_id: string; p_property_id?: string }
        Returns: Json
      }
      staxis_record_account_lifecycle_auth_snapshot: {
        Args: {
          p_banned_until: string
          p_operation_id: string
          p_processor_token: string
        }
        Returns: Json
      }
      staxis_record_ai_feature_validation: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_checked_at: string
          p_config_id: string
          p_request_id: string
          p_validation_report: Json
          p_validation_status: string
        }
        Returns: undefined
      }
      staxis_record_assistant_turn: {
        Args: {
          p_conversation_id: string
          p_cost_usd: number
          p_model: string
          p_model_id: string
          p_prompt_version: string
          p_text: string
          p_tokens_in: number
          p_tokens_out: number
          p_tool_calls: Json
        }
        Returns: undefined
      }
      staxis_record_inventory_loss: {
        Args: {
          p_expected_stock: number
          p_item_id: string
          p_notes: string
          p_property_id: string
          p_quantity: number
          p_reason: string
          p_recorded_at: string
          p_recorded_by: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_inventory_loss_0334_impl: {
        Args: {
          p_expected_stock: number
          p_item_id: string
          p_notes: string
          p_property_id: string
          p_quantity: number
          p_reason: string
          p_recorded_at: string
          p_recorded_by: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_inventory_opening_adjustment: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_adjustment_quantity: number
          p_effective_at: string
          p_expected_stock: number
          p_item_id: string
          p_property_id: string
          p_request_id: string
          p_resulting_stock: number
          p_unit_cost: number
        }
        Returns: Json
      }
      staxis_record_inventory_order_intent: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_item_id: string
          p_ordered_at: string
          p_property_id: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_record_ml_failure: {
        Args: { p_err: string; p_kind: string; p_pid: string }
        Returns: undefined
      }
      staxis_refresh_ai_model_catalog: {
        Args: {
          p_actor_account_id: string
          p_actor_email: string
          p_actor_user_id: string
          p_missing_model_ids: string[]
          p_models: Json
          p_provider: string
          p_refreshed_at: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_refresh_inventory_delivery_metadata: {
        Args: {
          p_changed_root_id: string
          p_item_id: string
          p_property_id: string
        }
        Returns: undefined
      }
      staxis_register_account_lifecycle_intent: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_desired_active: boolean
          p_expected_active: boolean
          p_expected_auth_user_id: string
          p_expected_intent_version: number
          p_expected_property_access: string[]
          p_expected_role: string
          p_hotel_id: string
          p_operation_id: string
          p_target_account_id: string
        }
        Returns: Json
      }
      staxis_read_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_hotel_id: string
        }
        Returns: Json
      }
      staxis_release_account_lifecycle_processor: {
        Args: { p_operation_id: string; p_processor_token: string }
        Returns: Json
      }
      staxis_release_join_code_slot: { Args: { p_id: string }; Returns: number }
      staxis_release_password_signin_proof: {
        Args: { p_id: string }
        Returns: undefined
      }
      staxis_remove_property_access: {
        Args: { p_account_id: string; p_hotel_id: string }
        Returns: number
      }
      staxis_remove_property_access_guarded: {
        Args: {
          p_account_id: string
          p_expected_role: string
          p_expected_updated_at: string
          p_hotel_id: string
        }
        Returns: Json
      }
      staxis_require_inventory_section: {
        Args: { p_property_id: string }
        Returns: undefined
      }
      staxis_reserve_agent_spend: {
        Args: {
          p_estimated_usd: number
          p_global_cap_usd?: number
          p_property_cap_usd?: number
          p_property_id: string
          p_user_cap_usd?: number
          p_user_id: string
        }
        Returns: {
          global_spend_usd: number
          ok: boolean
          property_spend_usd: number
          reason: string
          reservation_id: string
          user_spend_usd: number
        }[]
      }
      staxis_reserve_phone_pairing_resend: {
        Args: { p_challenge_token_hash: string }
        Returns: {
          account_id: string
          auth_user_id: string
          challenge_expires_at: string
          pairing_id: string
          send_count: number
          send_reservation_id: string
        }[]
      }
      staxis_reset_stuck_sms_jobs: {
        Args: { p_max_seconds?: number }
        Returns: number
      }
      staxis_resolve_join_code_capability: {
        Args: { p_code: string }
        Returns: Json
      }
      staxis_resolve_or_mint_resume_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code: string
          p_hotel_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_resolve_organization_property_topology: {
        Args: { p_effective_at: string; p_organization_id: string }
        Returns: Json
      }
      staxis_restore_conversation: {
        Args: { p_conversation_id: string }
        Returns: number
      }
      staxis_review_organization_access_request: {
        Args: {
          p_actor_account_id: string
          p_decision: string
          p_expires_at?: string
          p_request_id: string
          p_review_note?: string
        }
        Returns: string
      }
      staxis_revoke_organization_access: {
        Args: {
          p_actor_account_id: string
          p_grant_id: string
          p_reason: string
        }
        Returns: boolean
      }
      staxis_revoke_staff_join_code_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_code_id: string
          p_request_id?: string
        }
        Returns: Json
      }
      staxis_save_inventory_count: {
        Args: {
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_save_inventory_count_0334_impl: {
        Args: {
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_save_inventory_count_for_actor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_counted_at: string
          p_counted_by: string
          p_property_id: string
          p_request_id: string
          p_rows: Json
        }
        Returns: Json
      }
      staxis_schedule_auto_fill_if_absent: {
        Args: {
          p_crew: string[]
          p_csv_pulled_at: string
          p_csv_room_snapshot: Json
          p_date: string
          p_property: string
          p_room_assignments: Json
          p_staff_names: Json
        }
        Returns: boolean
      }
      staxis_search_knowledge_chunks:
        | {
            Args: {
              p_dept: string
              p_include_manager_only: boolean
              p_match_count: number
              p_property_id: string
              p_query_embedding: string
            }
            Returns: {
              article_id: string
              chunk_index: number
              content: string
              document_id: string
              id: string
              section: string
              similarity: number
              source_type: string
              visibility: string
            }[]
          }
        | {
            Args: {
              p_include_manager_only: boolean
              p_match_count: number
              p_property_id: string
              p_query_embedding: string
            }
            Returns: {
              article_id: string
              chunk_index: number
              content: string
              document_id: string
              id: string
              section: string
              similarity: number
              source_type: string
              visibility: string
            }[]
          }
      staxis_seed_shift_assignments: {
        Args: {
          p_assignments: Json
          p_date: string
          p_plan_rooms: Json
          p_property: string
        }
        Returns: Json
      }
      staxis_set_primary_property_organization: {
        Args: {
          p_actor_account_id: string
          p_organization_id: string
          p_property_id: string
          p_relationship_type?: string
        }
        Returns: string
      }
      staxis_set_report_inbox: {
        Args: { p_local: string; p_property_id: string }
        Returns: string
      }
      staxis_set_staff_language: {
        Args: { p_conf_token: string; p_lang: string; p_staff: string }
        Returns: undefined
      }
      staxis_start_inventory_month_close: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_month_start: string
          p_property_id: string
          p_request_id: string
        }
        Returns: string
      }
      staxis_store_memory: {
        Args: {
          p_confidence?: string
          p_content: string
          p_created_by_account_id?: string
          p_created_by_name?: string
          p_created_by_role?: string
          p_expires_at?: string
          p_property_cap?: number
          p_property_id: string
          p_scope: string
          p_source?: string
          p_source_conversation_id?: string
          p_subject_account_id: string
          p_topic: string
          p_user_cap?: number
        }
        Returns: {
          action: string
          memory_id: string
        }[]
      }
      staxis_store_phone_pairing_otp: {
        Args: {
          p_challenge_token_hash: string
          p_otp_digest: string
          p_pairing_id: string
          p_send_count: number
          p_send_reservation_id: string
          p_supabase_hashed_token: string
        }
        Returns: boolean
      }
      staxis_swap_active_recipe: {
        Args: { p_new_recipe_id: string; p_pms_type: string }
        Returns: undefined
      }
      staxis_sweep_stale_reservations: {
        Args: { p_max_age_minutes?: number }
        Returns: {
          oldest_age_seconds: number
          swept_count: number
        }[]
      }
      staxis_transfer_ownership: {
        Args: {
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_property_id: string
        }
        Returns: string
      }
      staxis_transfer_ownership_guarded: {
        Args: {
          p_actor_account_id: string
          p_actor_auth_user_id: string
          p_actor_email: string
          p_expected_new_active: boolean
          p_expected_new_auth_user_id: string
          p_expected_new_intent_version: number
          p_expected_new_property_access: string[]
          p_expected_new_role: string
          p_expected_old_active: boolean
          p_expected_old_auth_user_id: string
          p_expected_old_intent_version: number
          p_expected_old_property_access: string[]
          p_expected_old_role: string
          p_new_owner_account_id: string
          p_old_owner_account_id: string
          p_operation_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      staxis_update_inventory_property_config: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_budget_mode: string
          p_property_id: string
          p_tab_layout: Json
        }
        Returns: boolean
      }
      staxis_update_inventory_vendor: {
        Args: {
          p_actor_id: string
          p_actor_name: string
          p_patch: Json
          p_property_id: string
          p_vendor_id: string
        }
        Returns: Json
      }
      staxis_upsert_scraper_credentials: {
        Args: {
          p_login_url: string
          p_password: string
          p_pms_type: string
          p_property_id: string
          p_username: string
        }
        Returns: undefined
      }
      staxis_user_can_manage_equipment: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_manage_inventory_operations: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_manage_staff: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_user_can_view_inventory_financials: {
        Args: { p_property_id: string }
        Returns: boolean
      }
      staxis_verify_legacy_archived_inventory_zero: {
        Args: {
          p_expected_archived_at: string
          p_item_id: string
          p_property_id: string
          p_reason: string
          p_request_id: string
          p_verified_by: string
        }
        Returns: Json
      }
      staxis_verify_phone_pairing: {
        Args: {
          p_challenge_token_hash: string
          p_completion_token_hash: string
          p_otp_digest: string
        }
        Returns: {
          auth_user_id: string
          completion_expires_at: string
          pairing_id: string
          supabase_hashed_token: string
          verified: boolean
        }[]
      }
      staxis_walkthrough_end: {
        Args: { p_run_id: string; p_status: string }
        Returns: undefined
      }
      staxis_walkthrough_heal_stale: {
        Args: { p_dry_run?: boolean }
        Returns: number
      }
      staxis_walkthrough_start: {
        Args: { p_property_id: string; p_task: string; p_user_id: string }
        Returns: string
      }
      staxis_walkthrough_step: {
        Args: {
          p_expected_property_id?: string
          p_expected_user_id?: string
          p_run_id: string
        }
        Returns: number
      }
      today_property_counts_v1: {
        Args: { p_date: string; p_property_id: string }
        Returns: {
          checkouts: number
          in_house: number
          ooo: number
          stayovers: number
          total_checkouts_today: number
          total_rooms: number
          vacant_clean: number
          vacant_dirty: number
        }[]
      }
      today_room_work_v1: {
        Args: { p_date: string; p_property_id: string }
        Returns: {
          housekeeper: string
          room_number: string
          stay_type: string
          stayover_day: number
        }[]
      }
      user_manages_property: { Args: { p_id: string }; Returns: boolean }
      user_owns_property: { Args: { p_id: string }; Returns: boolean }
    }
    Enums: {
      cleaning_event_status:
        "recorded" | "discarded" | "flagged" | "approved" | "rejected"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      cleaning_event_status: [
        "recorded",
        "discarded",
        "flagged",
        "approved",
        "rejected",
      ],
    },
  },
} as const
