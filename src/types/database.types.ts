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
      accounts: {
        Row: {
          ai_cost_tier: string
          created_at: string
          data_user_id: string
          display_name: string
          id: string
          password_hash: string | null
          phone: string | null
          property_access: string[]
          role: string
          skip_2fa: boolean
          updated_at: string
          username: string
          voice_onboarded_at: string | null
          voice_replies_enabled: boolean
          wake_word_enabled: boolean
        }
        Insert: {
          ai_cost_tier?: string
          created_at?: string
          data_user_id: string
          display_name: string
          id?: string
          password_hash?: string | null
          phone?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          updated_at?: string
          username: string
          voice_onboarded_at?: string | null
          voice_replies_enabled?: boolean
          wake_word_enabled?: boolean
        }
        Update: {
          ai_cost_tier?: string
          created_at?: string
          data_user_id?: string
          display_name?: string
          id?: string
          password_hash?: string | null
          phone?: string | null
          property_access?: string[]
          role?: string
          skip_2fa?: boolean
          updated_at?: string
          username?: string
          voice_onboarded_at?: string | null
          voice_replies_enabled?: boolean
          wake_word_enabled?: boolean
        }
        Relationships: []
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
        Relationships: []
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
      agent_prompts: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          notes: string | null
          parent_version: string | null
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
      agent_voice_sessions: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          data_user_id: string
          expires_at: string
          id: string
          property_id: string
          role_snapshot: string
          staff_id_snapshot: string | null
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          data_user_id: string
          expires_at?: string
          id?: string
          property_id: string
          role_snapshot: string
          staff_id_snapshot?: string | null
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          data_user_id?: string
          expires_at?: string
          id?: string
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
        Relationships: [
          {
            foreignKeyName: "api_limits_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
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
          avg_turnaround_minutes: number | null
          checkouts: number | null
          completion_time: string | null
          created_at: string
          date: string
          early_checkins: number | null
          hourly_wage: number | null
          id: string
          labor_cost: number | null
          labor_saved: number | null
          laundry_loads: Json | null
          laundry_minutes: number | null
          occupied: number | null
          property_id: string
          public_area_minutes: number | null
          public_areas_due_today: string[] | null
          recommended_staff: number | null
          room_minutes: number | null
          rooms_completed: number | null
          start_time: string | null
          stayovers: number | null
          total_minutes: number | null
          two_bed_checkouts: number | null
          updated_at: string
          vips: number | null
        }
        Insert: {
          actual_staff?: number | null
          avg_turnaround_minutes?: number | null
          checkouts?: number | null
          completion_time?: string | null
          created_at?: string
          date: string
          early_checkins?: number | null
          hourly_wage?: number | null
          id?: string
          labor_cost?: number | null
          labor_saved?: number | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          occupied?: number | null
          property_id: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          room_minutes?: number | null
          rooms_completed?: number | null
          start_time?: string | null
          stayovers?: number | null
          total_minutes?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
        }
        Update: {
          actual_staff?: number | null
          avg_turnaround_minutes?: number | null
          checkouts?: number | null
          completion_time?: string | null
          created_at?: string
          date?: string
          early_checkins?: number | null
          hourly_wage?: number | null
          id?: string
          labor_cost?: number | null
          labor_saved?: number | null
          laundry_loads?: Json | null
          laundry_minutes?: number | null
          occupied?: number | null
          property_id?: string
          public_area_minutes?: number | null
          public_areas_due_today?: string[] | null
          recommended_staff?: number | null
          room_minutes?: number | null
          rooms_completed?: number | null
          start_time?: string | null
          stayovers?: number | null
          total_minutes?: number | null
          two_bed_checkouts?: number | null
          updated_at?: string
          vips?: number | null
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
          last_deep_clean: string
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
          last_deep_clean: string
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
          last_deep_clean?: string
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
          status: string
          updated_at: string
          vendor_id: string | null
          warranty_end_date: string | null
        }
        Insert: {
          category: string
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
          status?: string
          updated_at?: string
          vendor_id?: string | null
          warranty_end_date?: string | null
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
          status?: string
          updated_at?: string
          vendor_id?: string | null
          warranty_end_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "equipment_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
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
      hotel_join_codes: {
        Row: {
          code: string
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
      inspections: {
        Row: {
          created_at: string
          due_month: string
          frequency_days: number | null
          frequency_months: number
          id: string
          last_inspected_date: string | null
          name: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          due_month: string
          frequency_days?: number | null
          frequency_months: number
          id?: string
          last_inspected_date?: string | null
          name: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          due_month?: string
          frequency_days?: number | null
          frequency_months?: number
          id?: string
          last_inspected_date?: string | null
          name?: string
          notes?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspections_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          case_unit: string | null
          category: string
          current_stock: number
          id: string
          last_alerted_at: string | null
          last_counted_at: string | null
          last_ordered_at: string | null
          name: string
          notes: string | null
          pack_size: number | null
          par_level: number
          property_id: string
          reorder_at: number | null
          reorder_lead_days: number | null
          unit: string
          unit_cost: number | null
          updated_at: string
          usage_per_checkout: number | null
          usage_per_stayover: number | null
          vendor_name: string | null
        }
        Insert: {
          case_unit?: string | null
          category: string
          current_stock?: number
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name: string
          notes?: string | null
          pack_size?: number | null
          par_level?: number
          property_id: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          unit: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_name?: string | null
        }
        Update: {
          case_unit?: string | null
          category?: string
          current_stock?: number
          id?: string
          last_alerted_at?: string | null
          last_counted_at?: string | null
          last_ordered_at?: string | null
          name?: string
          notes?: string | null
          pack_size?: number | null
          par_level?: number
          property_id?: string
          reorder_at?: number | null
          reorder_lead_days?: number | null
          unit?: string
          unit_cost?: number | null
          updated_at?: string
          usage_per_checkout?: number | null
          usage_per_stayover?: number | null
          vendor_name?: string | null
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
      inventory_budgets: {
        Row: {
          budget_cents: number
          category: string
          created_at: string
          month_start: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          budget_cents: number
          category: string
          created_at?: string
          month_start: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
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
          unit_cost: number | null
          variance: number | null
          variance_value: number | null
        }
        Insert: {
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
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Update: {
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
          unit_cost?: number | null
          variance?: number | null
          variance_value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_counts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
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
      inventory_discards: {
        Row: {
          cost_value: number | null
          created_at: string
          discarded_at: string
          discarded_by: string | null
          id: string
          item_id: string
          item_name: string
          notes: string | null
          property_id: string
          quantity: number
          reason: string
          unit_cost: number | null
        }
        Insert: {
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          property_id: string
          quantity: number
          reason: string
          unit_cost?: number | null
        }
        Update: {
          cost_value?: number | null
          created_at?: string
          discarded_at?: string
          discarded_by?: string | null
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          property_id?: string
          quantity?: number
          reason?: string
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_discards_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_discards_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
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
      inventory_orders: {
        Row: {
          created_at: string
          id: string
          item_id: string
          item_name: string
          notes: string | null
          ordered_at: string | null
          property_id: string
          quantity: number
          quantity_cases: number | null
          received_at: string
          total_cost: number | null
          unit_cost: number | null
          vendor_name: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          item_name: string
          notes?: string | null
          ordered_at?: string | null
          property_id: string
          quantity: number
          quantity_cases?: number | null
          received_at?: string
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          item_name?: string
          notes?: string | null
          ordered_at?: string | null
          property_id?: string
          quantity?: number
          quantity_cases?: number | null
          received_at?: string
          total_cost?: number | null
          unit_cost?: number | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_orders_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_orders_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
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
      inventory_rate_prediction_history: {
        Row: {
          id: string
          is_shadow: boolean | null
          item_id: string | null
          item_name: string | null
          model_run_id: string | null
          predicted_at: string | null
          predicted_current_stock: number | null
          predicted_daily_rate: number | null
          predicted_daily_rate_p10: number | null
          predicted_daily_rate_p25: number | null
          predicted_daily_rate_p50: number | null
          predicted_daily_rate_p75: number | null
          predicted_daily_rate_p90: number | null
          predicted_for_date: string
          property_id: string
          recorded_at: string
          source_prediction_id: string
        }
        Insert: {
          id?: string
          is_shadow?: boolean | null
          item_id?: string | null
          item_name?: string | null
          model_run_id?: string | null
          predicted_at?: string | null
          predicted_current_stock?: number | null
          predicted_daily_rate?: number | null
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date: string
          property_id: string
          recorded_at?: string
          source_prediction_id: string
        }
        Update: {
          id?: string
          is_shadow?: boolean | null
          item_id?: string | null
          item_name?: string | null
          model_run_id?: string | null
          predicted_at?: string | null
          predicted_current_stock?: number | null
          predicted_daily_rate?: number | null
          predicted_daily_rate_p10?: number | null
          predicted_daily_rate_p25?: number | null
          predicted_daily_rate_p50?: number | null
          predicted_daily_rate_p75?: number | null
          predicted_daily_rate_p90?: number | null
          predicted_for_date?: string
          property_id?: string
          recorded_at?: string
          source_prediction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_rate_prediction_history_property_id_fkey"
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
            foreignKeyName: "inventory_rate_predictions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
          },
          {
            foreignKeyName: "inventory_rate_predictions_model_run_id_fkey"
            columns: ["model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
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
          n_hotels_contributing: number
          prior_rate_per_room_per_day: number
          prior_strength: number
          source: string
          updated_at: string
        }
        Insert: {
          cohort_key: string
          id?: string
          item_canonical_name: string
          n_hotels_contributing?: number
          prior_rate_per_room_per_day: number
          prior_strength?: number
          source?: string
          updated_at?: string
        }
        Update: {
          cohort_key?: string
          id?: string
          item_canonical_name?: string
          n_hotels_contributing?: number
          prior_rate_per_room_per_day?: number
          prior_strength?: number
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
          system_estimate?: number
          unaccounted_variance?: number
          unaccounted_variance_value?: number | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_reconciliations_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_reconciliations_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
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
      landscaping_tasks: {
        Row: {
          created_at: string
          frequency_days: number
          id: string
          last_completed_at: string | null
          last_completed_by: string | null
          name: string
          notes: string | null
          property_id: string
          season: string
        }
        Insert: {
          created_at?: string
          frequency_days: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name: string
          notes?: string | null
          property_id: string
          season: string
        }
        Update: {
          created_at?: string
          frequency_days?: number
          id?: string
          last_completed_at?: string | null
          last_completed_by?: string | null
          name?: string
          notes?: string | null
          property_id?: string
          season?: string
        }
        Relationships: [
          {
            foreignKeyName: "landscaping_tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
            foreignKeyName: "model_runs_property_id_fkey"
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
          {
            foreignKeyName: "onboarding_jobs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "pms_recipes"
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
      plan_snapshots: {
        Row: {
          arrival_room_numbers: string[]
          arrivals: number
          checkout_minutes: number
          checkout_room_numbers: string[]
          checkouts: number
          date: string
          ooo: number
          ooo_room_numbers: string[]
          property_id: string
          pull_type: string
          pulled_at: string
          recommended_hks: number
          rooms: Json
          stayover_arrival_day: number
          stayover_arrival_room_numbers: string[]
          stayover_day1: number
          stayover_day1_minutes: number
          stayover_day1_room_numbers: string[]
          stayover_day2: number
          stayover_day2_minutes: number
          stayover_day2_room_numbers: string[]
          stayover_unknown: number
          stayovers: number
          total_cleaning_minutes: number
          total_rooms: number
          vacant_clean: number
          vacant_clean_room_numbers: string[]
          vacant_dirty: number
          vacant_dirty_minutes: number
          vacant_dirty_room_numbers: string[]
        }
        Insert: {
          arrival_room_numbers?: string[]
          arrivals?: number
          checkout_minutes?: number
          checkout_room_numbers?: string[]
          checkouts?: number
          date: string
          ooo?: number
          ooo_room_numbers?: string[]
          property_id: string
          pull_type: string
          pulled_at?: string
          recommended_hks?: number
          rooms?: Json
          stayover_arrival_day?: number
          stayover_arrival_room_numbers?: string[]
          stayover_day1?: number
          stayover_day1_minutes?: number
          stayover_day1_room_numbers?: string[]
          stayover_day2?: number
          stayover_day2_minutes?: number
          stayover_day2_room_numbers?: string[]
          stayover_unknown?: number
          stayovers?: number
          total_cleaning_minutes?: number
          total_rooms?: number
          vacant_clean?: number
          vacant_clean_room_numbers?: string[]
          vacant_dirty?: number
          vacant_dirty_minutes?: number
          vacant_dirty_room_numbers?: string[]
        }
        Update: {
          arrival_room_numbers?: string[]
          arrivals?: number
          checkout_minutes?: number
          checkout_room_numbers?: string[]
          checkouts?: number
          date?: string
          ooo?: number
          ooo_room_numbers?: string[]
          property_id?: string
          pull_type?: string
          pulled_at?: string
          recommended_hks?: number
          rooms?: Json
          stayover_arrival_day?: number
          stayover_arrival_room_numbers?: string[]
          stayover_day1?: number
          stayover_day1_minutes?: number
          stayover_day1_room_numbers?: string[]
          stayover_day2?: number
          stayover_day2_minutes?: number
          stayover_day2_room_numbers?: string[]
          stayover_unknown?: number
          stayovers?: number
          total_cleaning_minutes?: number
          total_rooms?: number
          vacant_clean?: number
          vacant_clean_room_numbers?: string[]
          vacant_dirty?: number
          vacant_dirty_minutes?: number
          vacant_dirty_room_numbers?: string[]
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
      pms_recipes: {
        Row: {
          created_at: string
          id: string
          learned_by_property_id: string | null
          notes: string | null
          pms_type: string
          recipe: Json
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          learned_by_property_id?: string | null
          notes?: string | null
          pms_type: string
          recipe: Json
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          learned_by_property_id?: string | null
          notes?: string | null
          pms_type?: string
          recipe?: Json
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "pms_recipes_learned_by_property_id_fkey"
            columns: ["learned_by_property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_disagreement: {
        Row: {
          date: string
          detected_at: string
          disagreement_pct: number
          id: string
          layer1_model_run_id: string
          layer1_total_p50: number
          layer2_model_run_id: string
          layer2_summed_p50: number
          property_id: string
          threshold_used: number
        }
        Insert: {
          date: string
          detected_at?: string
          disagreement_pct: number
          id?: string
          layer1_model_run_id: string
          layer1_total_p50: number
          layer2_model_run_id: string
          layer2_summed_p50: number
          property_id: string
          threshold_used: number
        }
        Update: {
          date?: string
          detected_at?: string
          disagreement_pct?: number
          id?: string
          layer1_model_run_id?: string
          layer1_total_p50?: number
          layer2_model_run_id?: string
          layer2_summed_p50?: number
          property_id?: string
          threshold_used?: number
        }
        Relationships: [
          {
            foreignKeyName: "prediction_disagreement_layer1_model_run_id_fkey"
            columns: ["layer1_model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_disagreement_layer2_model_run_id_fkey"
            columns: ["layer2_model_run_id"]
            isOneToOne: false
            referencedRelation: "model_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_disagreement_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
            foreignKeyName: "prediction_log_inventory_count_id_fkey"
            columns: ["inventory_count_id"]
            isOneToOne: false
            referencedRelation: "inventory_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_log_inventory_count_id_fkey"
            columns: ["inventory_count_id"]
            isOneToOne: false
            referencedRelation: "inventory_observed_rate_v"
            referencedColumns: ["newer_count_id"]
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
      properties: {
        Row: {
          alert_phone: string | null
          avg_occupancy: number
          brand: string | null
          checkout_minutes: number
          climate_zone: string | null
          created_at: string
          dashboard_stale_minutes: number
          evening_forecast_time: string | null
          hourly_wage: number
          id: string
          inventory_ai_mode: string
          is_test: boolean
          last_synced_at: string | null
          morning_briefing_time: string | null
          name: string
          nudge_subscription: Json | null
          onboarding_completed_at: string | null
          onboarding_source: string
          onboarding_state: Json
          owner_id: string
          pms_connected: boolean | null
          pms_type: string | null
          pms_url: string | null
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
          checkout_minutes?: number
          climate_zone?: string | null
          created_at?: string
          dashboard_stale_minutes?: number
          evening_forecast_time?: string | null
          hourly_wage?: number
          id?: string
          inventory_ai_mode?: string
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          owner_id: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
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
          checkout_minutes?: number
          climate_zone?: string | null
          created_at?: string
          dashboard_stale_minutes?: number
          evening_forecast_time?: string | null
          hourly_wage?: number
          id?: string
          inventory_ai_mode?: string
          is_test?: boolean
          last_synced_at?: string | null
          morning_briefing_time?: string | null
          name?: string
          nudge_subscription?: Json | null
          onboarding_completed_at?: string | null
          onboarding_source?: string
          onboarding_state?: Json
          owner_id?: string
          pms_connected?: boolean | null
          pms_type?: string | null
          pms_url?: string | null
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
          {
            foreignKeyName: "pull_jobs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "pms_recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      pull_metrics: {
        Row: {
          created_at: string
          download_ms: number | null
          error_code: string | null
          id: string
          login_ms: number | null
          navigate_ms: number | null
          ok: boolean
          parse_ms: number | null
          property_id: string | null
          pull_type: string
          pulled_at: string
          rows: number | null
          total_ms: number
        }
        Insert: {
          created_at?: string
          download_ms?: number | null
          error_code?: string | null
          id?: string
          login_ms?: number | null
          navigate_ms?: number | null
          ok: boolean
          parse_ms?: number | null
          property_id?: string | null
          pull_type: string
          pulled_at?: string
          rows?: number | null
          total_ms: number
        }
        Update: {
          created_at?: string
          download_ms?: number | null
          error_code?: string | null
          id?: string
          login_ms?: number | null
          navigate_ms?: number | null
          ok?: boolean
          parse_ms?: number | null
          property_id?: string | null
          pull_type?: string
          pulled_at?: string
          rows?: number | null
          total_ms?: number
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
      rooms: {
        Row: {
          arrival: string | null
          assigned_name: string | null
          assigned_to: string | null
          checklist: Json | null
          completed_at: string | null
          created_at: string
          date: string
          dnd_note: string | null
          help_requested: boolean | null
          id: string
          inspected_at: string | null
          inspected_by: string | null
          is_dnd: boolean | null
          issue_note: string | null
          last_started_occupancy: number | null
          number: string
          photo_url: string | null
          priority: string
          property_id: string
          started_at: string | null
          status: string
          stayover_day: number | null
          stayover_minutes: number | null
          type: string
          updated_at: string
        }
        Insert: {
          arrival?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          checklist?: Json | null
          completed_at?: string | null
          created_at?: string
          date: string
          dnd_note?: string | null
          help_requested?: boolean | null
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          is_dnd?: boolean | null
          issue_note?: string | null
          last_started_occupancy?: number | null
          number: string
          photo_url?: string | null
          priority?: string
          property_id: string
          started_at?: string | null
          status?: string
          stayover_day?: number | null
          stayover_minutes?: number | null
          type: string
          updated_at?: string
        }
        Update: {
          arrival?: string | null
          assigned_name?: string | null
          assigned_to?: string | null
          checklist?: Json | null
          completed_at?: string | null
          created_at?: string
          date?: string
          dnd_note?: string | null
          help_requested?: boolean | null
          id?: string
          inspected_at?: string | null
          inspected_by?: string | null
          is_dnd?: boolean | null
          issue_note?: string | null
          last_started_occupancy?: number | null
          number?: string
          photo_url?: string | null
          priority?: string
          property_id?: string
          started_at?: string | null
          status?: string
          stayover_day?: number | null
          stayover_minutes?: number | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rooms_property_id_fkey"
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
      scraper_credentials: {
        Row: {
          ca_login_url: string
          ca_password_encrypted: string | null
          ca_username_encrypted: string | null
          created_at: string
          is_active: boolean
          notes: string | null
          pms_type: string
          property_id: string
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
          pms_type?: string
          property_id: string
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
          pms_type?: string
          property_id?: string
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
      scraper_status: {
        Row: {
          data: Json
          key: string
          updated_at: string
        }
        Insert: {
          data?: Json
          key: string
          updated_at?: string
        }
        Update: {
          data?: Json
          key?: string
          updated_at?: string
        }
        Relationships: []
      }
      service_contracts: {
        Row: {
          cadence: string
          category: string
          created_at: string
          id: string
          last_serviced_at: string | null
          monthly_cost: number | null
          name: string
          next_due_at: string | null
          notes: string | null
          property_id: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          cadence: string
          category: string
          created_at?: string
          id?: string
          last_serviced_at?: string | null
          monthly_cost?: number | null
          name: string
          next_due_at?: string | null
          notes?: string | null
          property_id: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          cadence?: string
          category?: string
          created_at?: string
          id?: string
          last_serviced_at?: string | null
          monthly_cost?: number | null
          name?: string
          next_due_at?: string | null
          notes?: string | null
          property_id?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_contracts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_contracts_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
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
      trusted_devices: {
        Row: {
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
          id: string
          message: string
          property_id: string | null
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
          id?: string
          message: string
          property_id?: string | null
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
          id?: string
          message?: string
          property_id?: string | null
          resolved_at?: string | null
          status?: string
          user_display_name?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
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
          category: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          id: string
          name: string
          notes: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          category: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          category?: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
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
      voice_recordings: {
        Row: {
          conversation_id: string | null
          cost_usd: number
          created_at: string
          duration_sec: number
          expires_at: string
          id: string
          language: string | null
          property_id: string | null
          storage_key: string
          transcript: string | null
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          cost_usd?: number
          created_at?: string
          duration_sec: number
          expires_at?: string
          id?: string
          language?: string | null
          property_id?: string | null
          storage_key: string
          transcript?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          cost_usd?: number
          created_at?: string
          duration_sec?: number
          expires_at?: string
          id?: string
          language?: string | null
          property_id?: string | null
          storage_key?: string
          transcript?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_recordings_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_recordings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_recordings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "accounts"
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
          created_at: string
          description: string
          equipment_id: string | null
          id: string
          notes: string | null
          parts_used: string[]
          photo_url: string | null
          property_id: string
          repair_cost: number | null
          resolved_at: string | null
          room_number: string
          severity: string
          source: string | null
          status: string
          submitted_by: string | null
          submitted_by_name: string | null
          submitter_photo_path: string | null
          submitter_role: string | null
          updated_at: string
          vendor_id: string | null
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
          created_at?: string
          description: string
          equipment_id?: string | null
          id?: string
          notes?: string | null
          parts_used?: string[]
          photo_url?: string | null
          property_id: string
          repair_cost?: number | null
          resolved_at?: string | null
          room_number: string
          severity: string
          source?: string | null
          status: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string
          vendor_id?: string | null
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
          created_at?: string
          description?: string
          equipment_id?: string | null
          id?: string
          notes?: string | null
          parts_used?: string[]
          photo_url?: string | null
          property_id?: string
          repair_cost?: number | null
          resolved_at?: string | null
          room_number?: string
          severity?: string
          source?: string | null
          status?: string
          submitted_by?: string | null
          submitted_by_name?: string | null
          submitter_photo_path?: string | null
          submitter_role?: string | null
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "work_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
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
            foreignKeyName: "inventory_counts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_counts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "item_canonical_name_view"
            referencedColumns: ["item_id"]
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
      pg_tables_rls_status: {
        Row: {
          forcerowsecurity: boolean | null
          rowsecurity: boolean | null
          schemaname: unknown
          tablename: unknown
        }
        Relationships: []
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
      cleanup_idempotency_log: { Args: never; Returns: number }
      decrypt_pms_credential: { Args: { ciphertext: string }; Returns: string }
      encrypt_pms_credential: { Args: { plaintext: string }; Returns: string }
      exec_sql: { Args: { sql: string }; Returns: Json }
      promote_shadow_model_run: {
        Args: { p_active_id: string; p_shadow_id: string }
        Returns: undefined
      }
      staxis_activate_prompt: {
        Args: { p_id: string; p_role: string }
        Returns: undefined
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
      staxis_bulk_update_room_status: {
        Args: { p_date: string; p_property: string; p_updates: Json }
        Returns: Json
      }
      staxis_cancel_agent_spend: {
        Args: { p_reservation_id: string }
        Returns: undefined
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
      staxis_count_finalize_failures_today: { Args: never; Returns: number }
      staxis_count_stale_reservations: {
        Args: { p_max_age_minutes?: number }
        Returns: number
      }
      staxis_count_swept_today: { Args: never; Returns: number }
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
      staxis_refresh_rooms_from_pms: {
        Args: {
          p_date: string
          p_inventory: string[]
          p_property: string
          p_rooms: Json
        }
        Returns: Json
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
      staxis_reset_stuck_sms_jobs: {
        Args: { p_max_seconds?: number }
        Returns: number
      }
      staxis_restore_conversation: {
        Args: { p_conversation_id: string }
        Returns: number
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
      staxis_seed_shift_assignments: {
        Args: {
          p_assignments: Json
          p_date: string
          p_plan_rooms: Json
          p_property: string
        }
        Returns: Json
      }
      staxis_set_staff_language: {
        Args: { p_conf_token: string; p_lang: string; p_staff: string }
        Returns: undefined
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
        Args: { p_expected_property_id?: string; p_run_id: string }
        Returns: number
      }
      user_owns_property: { Args: { p_id: string }; Returns: boolean }
    }
    Enums: {
      cleaning_event_status:
        | "recorded"
        | "discarded"
        | "flagged"
        | "approved"
        | "rejected"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
